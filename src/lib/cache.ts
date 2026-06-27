import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import logger from "./logger";

let redis: Redis | null = null;

const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
if (redisUrl) {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  redis.on("error", (err: Error) => logger.error({ err }, "[Redis] Connection error"));
  redis.on("connect", () => logger.info("[Redis] Connected"));
} else {
  logger.warn("[Cache] No REDIS_URL configured — OTP and caching will not work");
}

/** Generate a stable cache key from an Express request.
 * INVARIANT: All GET requests must include restaurantId as a query param.
 * The cache key is derived from req.originalUrl — omitting restaurantId causes
 * cross-tenant cache collisions. See AdminComponents.jsx for correct usage. */
export function generateCacheKey(req: Request): string {
  const url = req.originalUrl || req.url;
  return createHash("sha256").update(url).digest("hex");
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    logger.warn({ err, key }, "[Cache] GET failed");
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    // Track key in a bucket set for efficient invalidation
    const bucketKey = getBucketKey(key);
    if (bucketKey) {
      await redis.sadd(bucketKey, key);
      // Set TTL on the bucket so it doesn't accumulate stale keys forever
      await redis.expire(bucketKey, ttlSeconds + 60);
    }
  } catch (err) {
    logger.warn({ err, key }, "[Cache] SET failed");
  }
}

export async function cacheDelete(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
    const bucketKey = getBucketKey(key);
    if (bucketKey) await redis.srem(bucketKey, key);
  } catch (err) {
    logger.warn({ err, key }, "[Cache] DEL failed");
  }
}

// Extract bucket key from a cache key (first segment before the first colon)
function getBucketKey(key: string): string | null {
  const idx = key.indexOf(':');
  if (idx === -1) return null;
  return `cachebucket:${key.slice(0, idx)}`;
}

async function scanAndDelete(pattern: string): Promise<void> {
  if (!redis) return;
  // Try SET-based bucket invalidation first
  const bucketKey = `cachebucket:${pattern.endsWith('*') ? pattern.slice(0, -1) : pattern}`;
  try {
    const memberCount = await redis.scard(bucketKey);
    if (memberCount > 0) {
      const keys = await redis.smembers(bucketKey);
      if (keys.length > 0) {
        await redis.del(...keys);
        await redis.del(bucketKey);
      }
      return;
    }
  } catch {
    // Fall through to SCAN if bucket approach fails
  }
  // Fallback: SCAN-based invalidation for keys set before the bucket tracking was added
  let cursor = '0';
  const keys: string[] = [];
  do {
    const reply = await redis.scan(cursor, 'MATCH', `${pattern}*`, 'COUNT', 100);
    cursor = reply[0];
    keys.push(...reply[1]);
  } while (cursor !== '0');
  if (keys.length > 0) await redis.del(...keys);
}

export async function cacheClear(prefix: string): Promise<void> {
  if (!redis) return;
  try {
    if (prefix.endsWith("*")) {
      const base = prefix.slice(0, -1);
      await scanAndDelete(`${base}*`);
    } else {
      await redis.del(prefix);
    }
  } catch (err) {
    logger.warn({ err, prefix }, "[Cache] CLEAR failed");
  }
}

export function isCacheReady(): boolean {
  return !!redis;
}

export async function clearCache(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    await scanAndDelete(`${pattern}*`);
    logger.info({ pattern }, "[Cache] Cleared entries");
  } catch (err) {
    logger.warn({ err, pattern }, "[Cache] CLEAR pattern failed");
  }
}

/** Express middleware that caches GET responses */
export function cacheMiddleware(prefix: string, ttlMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") {
      return next();
    }

    const tenantId = (req as any).user?.restaurantId || "public";
    const key = prefix + ":" + tenantId + ":" + generateCacheKey(req);
    const cached = await cacheGet<{ body: unknown; status: number }>(key);

    if (cached !== null) {
      return res.status(cached.status ?? 200).json(cached.body);
    }

    // Monkey-patch res.json to capture successful responses only
    const originalJson = res.json.bind(res);
    (res as any).json = (body: unknown) => {
      if (res.statusCode < 400) {
        // Atomic SET NX — avoids the extra GET round-trip of the old pattern.
        // Only sets if the key doesn't already exist (prevents overwriting a fresher entry).
        if (redis) {
          const ttlSec = Math.ceil(ttlMs / 1000);
          redis.set(key, JSON.stringify({ body, status: res.statusCode }), "EX", ttlSec, "NX")
            .then((result) => {
              if (result === "OK") {
                // Track key in bucket for efficient invalidation
                const bucketKey = getBucketKey(key);
                if (bucketKey) {
                  redis.sadd(bucketKey, key).catch(() => {});
                  redis.expire(bucketKey, ttlSec + 60).catch(() => {});
                }
              }
            })
            .catch(() => {});
        }
      }
      return originalJson(body);
    };

    next();
  };
}

/** Express middleware that clears cache keys after a successful mutation */
export function invalidateCache(prefixes: string[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const originalJson = res.json.bind(res);
    const originalSendStatus = res.sendStatus.bind(res);

    function clear() {
      for (const p of prefixes) {
        cacheClear(p).catch(() => {});
      }
    }

    (res as any).json = (body: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        clear();
      }
      return originalJson(body);
    };

    (res as any).sendStatus = (statusCode: number) => {
      if (statusCode >= 200 && statusCode < 300) {
        clear();
      }
      return originalSendStatus(statusCode);
    };

    next();
  };
}

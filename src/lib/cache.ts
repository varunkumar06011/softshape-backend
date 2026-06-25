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
  } catch (err) {
    logger.warn({ err, key }, "[Cache] SET failed");
  }
}

export async function cacheDelete(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, "[Cache] DEL failed");
  }
}

export async function cacheClear(prefix: string): Promise<void> {
  if (!redis) return;
  try {
    if (prefix.endsWith("*")) {
      const base = prefix.slice(0, -1);
      const keys = await redis.keys(`${base}*`);
      if (keys.length > 0) await redis.del(...keys);
    } else {
      await redis.del(prefix);
    }
  } catch (err) {
    logger.warn({ err, prefix }, "[Cache] CLEAR failed");
  }
}

export async function clearCache(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    const keys = await redis.keys(`${pattern}*`);
    if (keys.length > 0) await redis.del(...keys);
    logger.info({ count: keys.length, pattern }, "[Cache] Cleared entries");
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

    const key = prefix + ":" + generateCacheKey(req);
    const cached = await cacheGet<{ body: unknown; status: number }>(key);

    if (cached !== null) {
      return res.status(cached.status ?? 200).json(cached.body);
    }

    // Monkey-patch res.json to capture successful responses only
    const originalJson = res.json.bind(res);
    (res as any).json = (body: unknown) => {
      if (res.statusCode < 400) {
        // Prevent a slow concurrent request from overwriting a fresher cache entry
        cacheGet(key).then((existing) => {
          if (existing === null) {
            cacheSet(key, { body, status: res.statusCode }, Math.ceil(ttlMs / 1000)).catch(() => {});
          }
        });
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

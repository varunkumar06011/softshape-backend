// ─────────────────────────────────────────────────────────────────────────────
// Redis Cache Layer
// ─────────────────────────────────────────────────────────────────────────────
// Provides a Redis-backed caching layer for the backend with the following features:
//   1. Key-value get/set/delete with TTL (cacheGet/cacheSet/cacheDelete)
//   2. Pattern-based cache invalidation (cacheClear/clearCache) using bucket sets
//      and SCAN fallback for efficient bulk deletion
//   3. Express middleware for automatic GET response caching (cacheMiddleware)
//   4. Express middleware for automatic cache invalidation after mutations (invalidateCache)
//   5. OTP storage and rate-limiting counters (used by auth routes)
//
// If REDIS_URL is not configured, all cache operations silently no-op (return null/void).
// This allows the server to run without Redis in development.
//
// Cache key structure: <prefix>:<restaurantId>:<sha256(originalUrl)>
// Bucket tracking: each key is added to a Redis SET keyed by its prefix for efficient
// invalidation. Buckets have a TTL slightly longer than the key TTL to auto-clean.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";
import Redis from "ioredis";
import logger from "./logger";
import * as Sentry from "@sentry/node";

// Singleton Redis client — null if REDIS_URL is not configured
let redis: Redis | null = null;

// Initialize Redis connection if URL is provided. Uses lazyConnect to defer
// connection until first command, and maxRetriesPerRequest: 3 for resilience.
const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
if (redisUrl) {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  redis.on("error", (err: Error) => {
    logger.error({ err }, "[Redis] Connection error");
    Sentry.captureMessage('Redis connection error', 'error');
  });
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

// Retrieves a cached value by key. Returns null if Redis is not configured,
// the key doesn't exist, or parsing fails. Never throws — logs warnings on errors.
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

// Stores a value in cache with a TTL (in seconds). Also tracks the key in a
// bucket SET for efficient pattern-based invalidation later.
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

// Deletes a single cache key and removes it from its bucket SET.
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

// Extracts the bucket key from a cache key (first segment before the first colon).
// Returns null if the key has no colon. Used for grouping keys by prefix for bulk invalidation.
function getBucketKey(key: string): string | null {
  const idx = key.indexOf(':');
  if (idx === -1) return null;
  return `cachebucket:${key.slice(0, idx)}`;
}

// Scans Redis for keys matching a pattern and deletes them.
// First tries bucket-based invalidation (fast — uses SMEMBERS on a tracked SET).
// Falls back to SCAN-based iteration if the bucket doesn't exist (for keys set
// before bucket tracking was added or if bucket expired).
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

// Clears all cache entries matching a prefix pattern. If prefix ends with '*',
// performs pattern-based deletion; otherwise deletes the exact key.
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

// Returns true if Redis is configured and ready. Used to conditionally enable
// features that depend on caching (e.g. OTP storage).
export function isCacheReady(): boolean {
  return !!redis;
}

// Returns the Redis client instance (or null if not configured).
// Used by rate-limit-redis store for multi-instance rate limiting.
export function getRedisClient(): Redis | null {
  return redis;
}

// Alias for cacheClear with SCAN-based deletion. Logs the pattern being cleared.
export async function clearCache(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    await scanAndDelete(`${pattern}*`);
    logger.info({ pattern }, "[Cache] Cleared entries");
  } catch (err) {
    logger.warn({ err, pattern }, "[Cache] CLEAR pattern failed");
  }
}

/** Express middleware that caches GET responses.
 * Caches successful (status < 400) GET responses in Redis with the given prefix and TTL.
 * Cache keys are tenant-scoped: <prefix>:<restaurantId>:<hash(originalUrl)>.
 * Uses SET NX (set-if-not-exists) to avoid overwriting fresher entries from concurrent requests.
 * Non-GET requests pass through without caching.
 */
export function cacheMiddleware(prefix: string, ttlMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") {
      return next();
    }

    const tenantId = ((req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId) || "public";
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

/** Express middleware that clears cache keys after a successful mutation.
 * Monkey-patches res.json and res.sendStatus to intercept successful responses
 * (status 2xx) and clear all cache entries matching the given prefixes.
 * This ensures that after a POST/PUT/DELETE, stale cached GET responses are invalidated.
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Redis Cache Layer
// ─────────────────────────────────────────────────────────────────────────────
// Provides a Redis-backed caching layer for the backend with the following features:
//   1. Key-value get/set/delete with TTL (cacheGet/cacheSet/cacheDelete)
//   2. Pattern-based cache invalidation via version counters (cacheClear/clearCache)
//   3. Express middleware for automatic GET response caching (cacheMiddleware)
//   4. Express middleware for automatic cache invalidation after mutations (invalidateCache)
//   5. OTP storage and rate-limiting counters (used by auth routes)
//
// If REDIS_URL is not configured, all cache operations silently no-op (return null/void).
// This allows the server to run without Redis in development.
//
// Cache key structure: <prefix>:<version>:<restaurantId>:<sha256(originalUrl)>
// Version-based invalidation: each prefix has a version counter in Redis.
// Invalidating a prefix increments its version, so all old keys become unreachable
// and naturally expire via TTL. This eliminates SCAN-based iteration entirely.
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

// Stores a value in cache with a TTL (in seconds).
export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch (err) {
    logger.warn({ err, key }, "[Cache] SET failed");
  }
}

// Deletes a single cache key.
export async function cacheDelete(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, "[Cache] DEL failed");
  }
}

// In-memory version counter cache — avoids a Redis GET on every cacheMiddleware hit.
// Falls back to Redis INCR on first access per prefix, then cached locally.
const versionCache = new Map<string, number>();

// Returns the current version counter for a cache prefix.
// Used to build versioned cache keys so invalidation is O(1) — just increment the counter.
async function getCacheVersion(prefix: string): Promise<number> {
  const cached = versionCache.get(prefix);
  if (cached !== undefined) return cached;
  if (!redis) return 0;
  try {
    const versionKey = `cacheversion:${prefix}`;
    const val = await redis.get(versionKey);
    const v = val ? Number(val) : 0;
    versionCache.set(prefix, v);
    return v;
  } catch {
    return 0;
  }
}

// Increments the version counter for a prefix, making all old cache keys unreachable.
// Old keys naturally expire via TTL — no SCAN or bucket deletion needed.
async function incrementCacheVersion(prefix: string): Promise<void> {
  if (!redis) return;
  try {
    const versionKey = `cacheversion:${prefix}`;
    const newVersion = await redis.incr(versionKey);
    versionCache.set(prefix, newVersion);
  } catch (err) {
    logger.warn({ err, prefix }, "[Cache] Version increment failed");
  }
}

// Clears all cache entries matching a prefix pattern by incrementing the version counter.
// Old keys become unreachable and naturally expire via TTL — no SCAN needed.
export async function cacheClear(prefix: string): Promise<void> {
  if (!redis) return;
  try {
    if (prefix.endsWith("*")) {
      const base = prefix.slice(0, -1);
      await incrementCacheVersion(base);
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

// Alias for cacheClear. Logs the pattern being cleared.
export async function clearCache(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    const base = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    await incrementCacheVersion(base);
    logger.info({ pattern }, "[Cache] Cleared entries (version bump)");
  } catch (err) {
    logger.warn({ err, pattern }, "[Cache] CLEAR pattern failed");
  }
}

/** Express middleware that caches GET responses.
 * Caches successful (status < 400) GET responses in Redis with the given prefix and TTL.
 * Cache keys are versioned and tenant-scoped: <prefix>:<version>:<restaurantId>:<hash(originalUrl)>.
 * Version-based invalidation: incrementing the version counter makes all old keys unreachable.
 * Non-GET requests pass through without caching.
 */
export function cacheMiddleware(prefix: string, ttlMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") {
      return next();
    }

    const tenantId = ((req as any).user?.activeRestaurantId ?? (req as any).user?.restaurantId) || "public";
    const version = await getCacheVersion(prefix);
    const key = prefix + ":" + version + ":" + tenantId + ":" + generateCacheKey(req);
    const cached = await cacheGet<{ body: unknown; status: number }>(key);

    if (cached !== null) {
      return res.status(cached.status ?? 200).json(cached.body);
    }

    // Monkey-patch res.json to capture successful responses only
    const originalJson = res.json.bind(res);
    (res as any).json = (body: unknown) => {
      if (res.statusCode < 400) {
        if (redis) {
          const ttlSec = Math.ceil(ttlMs / 1000);
          redis.set(key, JSON.stringify({ body, status: res.statusCode }), "EX", ttlSec, "NX")
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

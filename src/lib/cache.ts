import { createHash } from "crypto";

import type { Request, Response, NextFunction } from "express";



interface CacheEntry {

  data: unknown;

  expiresAt: number;

}



const store = new Map<string, CacheEntry>();

let hitCount = 0;

let missCount = 0;



/** Generate a stable cache key from an Express request */

export function generateCacheKey(req: Request): string {

  const url = req.originalUrl || req.url;

  return createHash("sha256").update(url).digest("hex");

}



/** Get a cached value by key */

export function cacheGet(key: string): unknown | undefined {

  const entry = store.get(key);

  if (!entry) {

    missCount++;

    return undefined;

  }

  if (Date.now() > entry.expiresAt) {

    store.delete(key);

    missCount++;

    return undefined;

  }

  hitCount++;

  return entry.data;

}



/** Set a cached value with TTL in milliseconds */

export function cacheSet(key: string, data: unknown, ttlMs: number): void {

  store.set(key, { data, expiresAt: Date.now() + ttlMs });

}



/** Delete a single cache key */

export function cacheDelete(key: string): void {

  store.delete(key);

}



/** Delete all keys matching a prefix (supports wildcard) */

export function cacheClear(prefix: string): void {

  if (prefix.endsWith("*")) {

    const base = prefix.slice(0, -1);

    for (const key of store.keys()) {

      if (key.startsWith(base)) store.delete(key);

    }

  } else {

    store.delete(prefix);

  }

}



/** Get cache stats for monitoring */

export function cacheStats(): { hits: number; misses: number; size: number; hitRate: string } {

  const total = hitCount + missCount;

  return {

    hits: hitCount,

    misses: missCount,

    size: store.size,

    hitRate: total > 0 ? `${((hitCount / total) * 100).toFixed(1)}%` : "N/A",

  };

}



/** Express middleware that caches GET responses */

export function cacheMiddleware(prefix: string, ttlMs: number) {

  return (req: Request, res: Response, next: NextFunction) => {

    if (req.method !== "GET") {

      return next();

    }



    const key = prefix + ":" + generateCacheKey(req);

    const cached = cacheGet(key);



    if (cached !== undefined) {

      // Re-hydrate JSON responses

      const payload = cached as { body: unknown; status: number };

      return res.status(payload.status ?? 200).json(payload.body);

    }



    // Monkey-patch res.json to capture successful responses only

    const originalJson = res.json.bind(res);

    (res as any).json = (body: unknown) => {

      if (res.statusCode < 400) {

        cacheSet(key, { body, status: res.statusCode }, ttlMs);

      }

      return originalJson(body);

    };



    next();

  };

}



// Optional: Clear cache by key pattern

export function clearCache(pattern: string) {

  const keysToDelete: string[] = [];

  for (const key of store.keys()) {

    if (key.startsWith(pattern)) {

      keysToDelete.push(key);

    }

  }

  keysToDelete.forEach(key => store.delete(key));

  console.log(`[Cache] Cleared ${keysToDelete.length} entries matching: ${pattern}`);

}

/** Express middleware that clears cache keys after a successful mutation */

export function invalidateCache(prefixes: string[]) {

  return (_req: Request, res: Response, next: NextFunction) => {

    const originalJson = res.json.bind(res);

    const originalSendStatus = res.sendStatus.bind(res);



    function clear() {

      for (const p of prefixes) {

        cacheClear(p);

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


// Simple in-memory cache middleware
const cacheStore = new Map<string, { data: any; expiresAt: number }>();

export function cacheMiddleware(key: string, ttlMs: number) {
  return (req: any, res: any, next: any) => {
    const cacheKey = `${key}:${req.originalUrl}`;
    const now = Date.now();
    const cached = cacheStore.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      console.log(`[Cache] HIT: ${cacheKey}`);
      return res.json(cached.data);
    }

    console.log(`[Cache] MISS: ${cacheKey}`);
    
    // Override res.json to cache the response
    const originalJson = res.json;
    res.json = function(data: any) {
      cacheStore.set(cacheKey, {
        data,
        expiresAt: now + ttlMs,
      });
      return originalJson.call(this, data);
    };

    next();
  };
}

// Optional: Clear cache by key pattern
export function clearCache(pattern: string) {
  const keysToDelete: string[] = [];
  for (const key of cacheStore.keys()) {
    if (key.startsWith(pattern)) {
      keysToDelete.push(key);
    }
  }
  keysToDelete.forEach(key => cacheStore.delete(key));
  console.log(`[Cache] Cleared ${keysToDelete.length} entries matching: ${pattern}`);
}

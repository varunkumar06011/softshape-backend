import Redis from 'ioredis';
import logger from './logger';

let redis: Redis | null = null;
let warnedNoRedis = false;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });
} else {
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    logger.warn('[redisLock] REDIS_URL not set — locks will be no-ops (fail-open)');
  }
}

export function isLockReady(): boolean {
  return redis !== null;
}

export async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  if (!redis) return true; // fail-open when Redis is unavailable
  try {
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.warn({ err, key }, '[redisLock] acquireLock failed — failing open');
    return true; // fail-open: allow operation to proceed
  }
}

export async function releaseLock(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, '[redisLock] releaseLock failed — ignoring');
  }
}

export async function withLock<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const acquired = await acquireLock(key, ttlSeconds);
  if (!acquired) return null;
  try {
    return await fn();
  } finally {
    await releaseLock(key);
  }
}

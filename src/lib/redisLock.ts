// ─────────────────────────────────────────────────────────────────────────────
// Redis Distributed Lock — Prevents concurrent operations on the same resource
// ─────────────────────────────────────────────────────────────────────────────
// Provides a simple distributed locking mechanism using Redis SET NX (set-if-not-exists).
// Used to prevent race conditions when multiple requests try to modify the same
// resource concurrently (e.g. order number generation, inventory deduction).
//
// Design principle: FAIL-OPEN. If Redis is unavailable, locks are granted
// (acquireLock returns true). This ensures the app remains functional even
// if Redis goes down — the worst case is a potential race condition, not a
// complete service outage.
//
// Usage:
//   const acquired = await acquireLock('order:123', 10);  // 10-second lock
//   if (!acquired) return res.status(409).json({ error: 'Concurrent operation in progress' });
//   try { /* do work */ } finally { await releaseLock('order:123'); }
//
//   // Or use the wrapper:
//   const result = await withLock('order:123', 10, async () => { /* do work */ });
//   if (result === null) return res.status(409).json({ error: 'Locked' });
// ─────────────────────────────────────────────────────────────────────────────

import Redis from 'ioredis';
import logger from './logger';

// Singleton Redis client for locks — separate from the cache Redis client
let redis: Redis | null = null;
let warnedNoRedis = false;

// Initialize Redis if URL is provided. If not, warn once and operate in fail-open mode.
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  redis.on('error', (err: Error) => {
    logger.warn({ err }, '[redisLock] Connection error');
  });
  redis.on('connect', () => logger.info('[redisLock] Connected'));
} else {
  if (!warnedNoRedis) {
    warnedNoRedis = true;
    logger.warn('[redisLock] REDIS_URL not set — locks will be no-ops (fail-open)');
  }
}

// Returns true if Redis is configured for locks. Used to check if locking is active.
export function isLockReady(): boolean {
  return redis !== null;
}

// Attempts to acquire a distributed lock. Returns true if the lock was acquired,
// false if another process holds it. Fails open (returns true) if Redis is unavailable.
// The lock auto-expires after ttlSeconds to prevent deadlocks if the holder crashes.
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

// Releases a distributed lock by deleting the key. Silently fails if Redis is unavailable.
export async function releaseLock(key: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn({ err, key }, '[redisLock] releaseLock failed — ignoring');
  }
}

// Convenience wrapper: acquires a lock, executes the async function, and releases the lock.
// Returns null if the lock could not be acquired (another process holds it).
// Returns the function's result on success. Always releases the lock in finally.
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

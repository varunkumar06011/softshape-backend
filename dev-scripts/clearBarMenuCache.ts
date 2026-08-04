/**
 * Clears the bar menu cache in Redis so newly added items appear immediately.
 * Usage: npx tsx dev-scripts/clearBarMenuCache.ts
 */
import { clearCache } from '../src/lib/cache';

async function main() {
  console.log('Clearing barMenu:* cache...');
  await clearCache('barMenu:*');
  console.log('Clearing menu:* cache...');
  await clearCache('menu:*');
  console.log('Done! Bar menu cache invalidated.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(async () => {
    const { getRedisClientRaw } = await import('../src/lib/cache');
    const redis = getRedisClientRaw();
    if (redis) await redis.quit();
    process.exit(0);
  });

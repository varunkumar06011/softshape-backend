// Flush menu/barMenu cache by incrementing version counters.
// This makes all cached menu/barMenu responses unreachable (they expire via TTL).
//
// Usage: npx tsx --env-file=.env dev-scripts/flushMenuCache.ts
//   (or)  npx ts-node --env-file=.env dev-scripts/flushMenuCache.ts

import 'dotenv/config';
import { clearCache } from '../src/lib/cache';

async function main() {
  console.log('\n=== Flushing menu & barMenu cache ===\n');
  console.log('REDIS_URL configured:', !!process.env.REDIS_URL);

  await clearCache('menu:*');
  console.log('  Cleared: menu:*');

  await clearCache('barMenu:*');
  console.log('  Cleared: barMenu:*');

  console.log('\n=== Done — menu caches invalidated ===\n');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  const restaurants = await prisma.restaurant.findMany({
    select: { id: true, slug: true, restaurantCode: true, restaurantType: true, enabledModules: true },
  });

  let migrated = 0, skipped = 0;

  for (const r of restaurants) {
    if (!r.enabledModules || typeof r.enabledModules !== 'object') {
      skipped++;
      continue;
    }

    const old = r.enabledModules as Record<string, boolean>;
    const next: Record<string, boolean> = {};

    for (const [k, v] of Object.entries(old)) {
      if (k === 'venue' || k === 'pricing' || k === 'inventory') continue;
      next[k] = v;
    }

    if (old.inventory === true) next.bar_inventory = true;
    if (old.pricing === true) next.bottle_tracking = true;

    const rt = (r.restaurantType || '').toUpperCase();
    if (next.bar === true) {
      if (rt === 'BAR_LOUNGE') {
        next.food = false;
      } else {
        next.food = next.food ?? true;
      }
    } else {
      next.food = next.food ?? true;
    }

    next.delivery = next.delivery ?? (rt === 'CLOUD_KITCHEN');

    if (next.tables === undefined) {
      next.tables = rt !== 'BAR_LOUNGE' && rt !== 'CAFE' && rt !== 'CLOUD_KITCHEN';
    }

    const changed = JSON.stringify(old) !== JSON.stringify(next);
    console.log(`${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ${r.slug} (${r.restaurantCode}) -> ${changed ? 'CHANGED' : 'no-op'} bar=${next.bar} food=${next.food} bar_inventory=${next.bar_inventory} bottle_tracking=${next.bottle_tracking}`);

    if (!DRY_RUN && changed) {
      await prisma.restaurant.update({
        where: { id: r.id },
        data: { enabledModules: next },
      });
      migrated++;
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped=${skipped} dryRun=${DRY_RUN}`);
}

main().finally(() => prisma.$disconnect());

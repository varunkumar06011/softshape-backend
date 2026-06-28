import { PrismaClient } from '@prisma/client';
import { computeEnabledModules } from '../src/lib/moduleDefaults';

const prisma = new PrismaClient();
const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  const outlets = await prisma.outlet.findMany({
    select: { id: true, slug: true, restaurantCode: true, restaurantType: true, enabledModules: true, organizationId: true },
  });

  let migrated = 0, skipped = 0;

  for (const o of outlets) {
    if (o.enabledModules) { skipped++; continue; }

    // Compute from outlet's own restaurantType, or fall back to org's enabledModules
    let enabledModules: Record<string, boolean>;
    if (o.restaurantType) {
      enabledModules = computeEnabledModules({ restaurantType: o.restaurantType });
    } else {
      const org = await prisma.organization.findUnique({
        where: { id: o.organizationId },
        select: { enabledModules: true },
      });
      if (org?.enabledModules) {
        enabledModules = org.enabledModules as Record<string, boolean>;
      } else {
        enabledModules = computeEnabledModules({ restaurantType: 'DINE_IN' });
      }
    }

    console.log(`${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ${o.slug} (${o.restaurantCode}) type=${o.restaurantType ?? 'unknown'} -> bar=${enabledModules.bar} food=${enabledModules.food} tables=${enabledModules.tables}`);

    if (!DRY_RUN) {
      await prisma.outlet.update({
        where: { id: o.id },
        data: { enabledModules },
      });
      migrated++;
    }
  }

  console.log(`\nDone. migrated=${migrated} skipped(already migrated)=${skipped} dryRun=${DRY_RUN}`);
}

main().finally(() => prisma.$disconnect());

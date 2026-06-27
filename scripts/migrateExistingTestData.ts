/**
 * One-time fixer for pre-launch test data.
 * Do not run in production. Delete after Step 3 cleanup migration.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

function jsonVal(v: unknown): Prisma.InputJsonValue | undefined {
  return v === null ? undefined : (v as Prisma.InputJsonValue);
}

async function main() {
  const roots = await prisma.restaurant.findMany({
    where: { parentRestaurantId: null },
  });

  for (const root of roots) {
    // Skip if already migrated
    if (root.organizationId) {
      console.log(`[Skip] Root ${root.id} already has organizationId`);
      continue;
    }

    // 1. Create Organization from root's billing fields
    const org = await prisma.organization.create({
      data: {
        name: root.name,
        plan: root.plan,
        subscriptionId: root.subscriptionId,
        billingStatus: root.billingStatus,
        trialEndsAt: root.trialEndsAt,
        paymentStatus: root.paymentStatus,
        features: jsonVal(root.features),
        enabledModules: jsonVal(root.enabledModules),
      },
    });

    // 2. Link root + all child outlets to this org
    const outlets = await prisma.restaurant.findMany({
      where: {
        OR: [{ id: root.id }, { parentRestaurantId: root.id }],
      },
    });

    for (const outlet of outlets) {
      await prisma.restaurant.update({
        where: { id: outlet.id },
        data: { organizationId: org.id },
      });
    }

    const outletIds = outlets.map(o => o.id);

    // 3. Fetch users in this tree
    const users = await prisma.user.findMany({
      where: { restaurantId: { in: outletIds } },
    });

    const ownerUsers = users.filter(u => u.role === 'OWNER');
    const nonOwnerUsers = users.filter(u => u.role !== 'OWNER');

    // 4. OWNER users get OutletAccess for EVERY outlet in the tree
    for (const owner of ownerUsers) {
      for (const outletId of outletIds) {
        await prisma.outletAccess.create({
          data: {
            userId: owner.id,
            outletId,
            role: owner.role,
            permissions: jsonVal(owner.permissions) ?? {},
          },
        });
      }
      console.log(`[Owner] ${owner.id} → ${outletIds.length} outlets`);
    }

    // 5. Non-owner users get OutletAccess for their current restaurantId only
    for (const user of nonOwnerUsers) {
      await prisma.outletAccess.create({
        data: {
          userId: user.id,
          outletId: user.restaurantId,
          role: user.role,
          permissions: jsonVal(user.permissions) ?? {},
        },
      });
      console.log(`[${user.role}] ${user.id} → ${user.restaurantId}`);
    }

    console.log(`[Done] Root ${root.id} (${root.name}) → Org ${org.id}, ${outlets.length} outlets, ${users.length} users`);
  }
}

main()
  .then(() => {
    console.log('[Migrate] Complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Migrate] Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

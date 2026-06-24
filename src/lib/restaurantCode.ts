import prisma from './prisma';

/**
 * Atomically allocates the next RESTAURANT-NNN code.
 * Uses a GlobalCounter row with a Postgres UPDATE ... RETURNING
 * to prevent race conditions under concurrent onboarding.
 *
 * If the counter is behind existing restaurants (e.g. after manual inserts or
 * restore), this function skips forward until it finds a unique code and syncs
 * the counter so future allocations are fast again.
 */
export async function allocateRestaurantCode(): Promise<string> {
  let attempts = 0;
  const maxAttempts = 100;

  while (attempts < maxAttempts) {
    attempts++;
    const result = await prisma.$queryRaw<[{ nextval: number }]>`
      UPDATE "GlobalCounter"
      SET "nextVal" = "nextVal" + 1
      WHERE "id" = 'global'
      RETURNING "nextVal" - 1 AS nextval
    `;
    const n = result[0].nextval;
    const code = `RESTAURANT-${String(n).padStart(3, '0')}`;

    const existing = await prisma.restaurant.findUnique({
      where: { restaurantCode: code },
      select: { id: true }
    });

    if (!existing) {
      // Fast path: sync counter ahead so the next allocation skips the gap
      await prisma.$executeRaw`
        UPDATE "GlobalCounter"
        SET "nextVal" = GREATEST("nextVal", ${n + 1})
        WHERE "id" = 'global'
      `;
      return code;
    }
  }

  throw new Error(`Could not allocate a unique restaurantCode after ${maxAttempts} attempts`);
}

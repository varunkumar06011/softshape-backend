import prisma from './prisma';

/**
 * Atomically allocates the next RESTAURANT-NNN code.
 * Uses a GlobalCounter row with a Postgres UPDATE ... RETURNING
 * to prevent race conditions under concurrent onboarding.
 */
export async function allocateRestaurantCode(): Promise<string> {
  const result = await prisma.$queryRaw<[{ nextval: number }]>`
    UPDATE "GlobalCounter"
    SET "nextVal" = "nextVal" + 1
    WHERE "id" = 'global'
    RETURNING "nextVal" - 1 AS nextval
  `;
  const n = result[0].nextval;
  return `RESTAURANT-${String(n).padStart(3, '0')}`;
}

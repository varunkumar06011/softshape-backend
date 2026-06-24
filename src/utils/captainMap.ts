/**
 * Captain name mapping
 * Centralized helper to look up captain display names from DB.
 * Old hardcoded map removed — names now come from the User table.
 */

import { basePrisma } from "../lib/prisma";

const nameCache = new Map<string, string>();

export const getCaptainName = async (id?: string): Promise<string | undefined> => {
  if (!id) return undefined;
  if (nameCache.has(id)) return nameCache.get(id);

  const user = await basePrisma.user.findFirst({
    where: { id },
    select: { name: true },
  });
  if (user?.name) {
    nameCache.set(id, user.name);
  }
  return user?.name ?? undefined;
};

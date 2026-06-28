// ─────────────────────────────────────────────────────────────────────────────
// Captain Map Utility — In-memory cache for captain display name lookups
// ─────────────────────────────────────────────────────────────────────────────
// Provides a cached lookup of captain (waiter) display names from the User table.
// Uses an in-memory Map cache to avoid repeated DB queries for the same captain.
// Cache is populated on first access and never invalidated (captain names rarely change).
//
// Uses basePrisma (unscoped) since captain lookups may happen outside tenant context.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Captain name mapping
 * Centralized helper to look up captain display names from DB.
 * Old hardcoded map removed — names now come from the User table.
 */

import { basePrisma } from "../lib/prisma";

// In-memory cache: userId → display name (never invalidated, populated on first access)
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

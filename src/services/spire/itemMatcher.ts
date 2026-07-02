// Per-tenant item matcher for the Spire AI agent.
// Fetches the tenant's actual MenuItem and Category names and matches them
// case-insensitively against tokens in the user's message. Runs independently
// of language routing so English item names embedded in Telugu sentences still resolve.

import { LRUCache } from 'lru-cache';
import prisma from '../../lib/prisma';

const menuCache = new LRUCache<string, { itemNames: string[]; categoryNames: string[] }>({
  max: 200,
  ttl: 2 * 60 * 60 * 1000, // 2 hours
});

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9\u0c00-\u0c7f]/g, '');
}

async function loadTenantMenu(tenantIds: string[]) {
  const cacheKey = tenantIds.sort().join(',');
  const cached = menuCache.get(cacheKey);
  if (cached) return cached;

  const [menuItems, categories] = await Promise.all([
    prisma.menuItem.findMany({
      where: { restaurantId: { in: tenantIds }, isDeleted: false },
      select: { name: true },
      distinct: ['name'],
    }),
    prisma.category.findMany({
      where: { restaurantId: { in: tenantIds } },
      select: { name: true },
      distinct: ['name'],
    }),
  ]);

  const result = {
    itemNames: menuItems.map(i => i.name).filter(Boolean),
    categoryNames: categories.map(c => c.name).filter(Boolean),
  };

  menuCache.set(cacheKey, result);
  return result;
}

export async function matchItem(
  message: string,
  tenantIds: string[],
): Promise<{ itemName?: string; categoryName?: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW' }> {
  const { itemNames, categoryNames } = await loadTenantMenu(tenantIds);

  const tokens = message
    .split(/\s+/)
    .map(t => normalizeToken(t))
    .filter(t => t.length >= 2);

  // Try exact token match first
  for (const token of tokens) {
    const itemExact = itemNames.find(n => normalizeToken(n) === token);
    if (itemExact) return { itemName: itemExact, confidence: 'HIGH' };
    const categoryExact = categoryNames.find(n => normalizeToken(n) === token);
    if (categoryExact) return { categoryName: categoryExact, confidence: 'HIGH' };
  }

  // Substring match: item name contained in a token, or token contained in item name
  for (const token of tokens) {
    const itemSub = itemNames.find(n => {
      const norm = normalizeToken(n);
      return norm.includes(token) || token.includes(norm);
    });
    if (itemSub) return { itemName: itemSub, confidence: 'MEDIUM' };
  }

  for (const token of tokens) {
    const categorySub = categoryNames.find(n => {
      const norm = normalizeToken(n);
      return norm.includes(token) || token.includes(norm);
    });
    if (categorySub) return { categoryName: categorySub, confidence: 'MEDIUM' };
  }

  return { confidence: 'LOW' };
}

export default matchItem;

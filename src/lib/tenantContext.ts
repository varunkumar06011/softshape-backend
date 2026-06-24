// Simplified compatibility layer for tenant context.
// The original multi-outlet model has been replaced with a strict 1:1 user-to-restaurant mapping.
// These helpers maintain the old API surface so existing route files compile with minimal changes.

export interface TenantContext {
  restaurantId: string;
  allIds: string[];
  barId?: string;
  gstin?: string;
}

export async function resolveTenantContext(restaurantId: string): Promise<TenantContext> {
  return { restaurantId, allIds: [restaurantId], barId: undefined, gstin: undefined };
}

export function isBarOutlet(id: string, _ctx?: TenantContext): boolean {
  return id.includes("bar");
}

export function isVenueOutlet(id: string, _ctx?: TenantContext): boolean {
  return id.includes("venue");
}

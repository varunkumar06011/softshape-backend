// ─────────────────────────────────────────────────────────────────────────────
// Module Defaults — Restaurant type to feature module mapping
// ─────────────────────────────────────────────────────────────────────────────
// Determines which feature modules are enabled for a restaurant based on its type.
// During onboarding, the restaurant owner selects a type (DINE_IN, BAR_LOUNGE, etc.)
// and this module computes which modules should be enabled by default.
//
// Core modules (always enabled): dashboard, menu, orders, transactions, reports,
// captains, settings, payroll.
//
// Type-specific modules (enabled based on restaurant type):
//   - tables          — table management (DINE_IN, BAR_WITH_DINING, CAFE)
//   - bar             — bar menu and features (BAR_LOUNGE, BAR_WITH_DINING)
//   - bar_inventory   — bar inventory tracking (BAR_LOUNGE, BAR_WITH_DINING)
//   - bottle_tracking — bottle-level tracking (BAR_LOUNGE, BAR_WITH_DINING)
//   - food            — food menu (all except BAR_LOUNGE)
//   - delivery        — delivery module (CLOUD_KITCHEN only)
//
// Disabled by default: marketing, surveillance (can be enabled later by admin)
// ─────────────────────────────────────────────────────────────────────────────

// Modules that are always enabled regardless of restaurant type
export const CORE_MODULES = ['dashboard', 'menu', 'orders', 'transactions', 'reports', 'captains', 'settings', 'payroll'] as const;

// Input for computing enabled modules
export interface ModuleInput {
  restaurantType: string;  // One of: DINE_IN, BAR_LOUNGE, BAR_WITH_DINING, CAFE, CLOUD_KITCHEN
}

// Mapping of restaurant type → which optional modules are enabled.
// Unknown types default to DINE_IN configuration.
const MODULE_MATRIX: Record<string, Record<string, boolean>> = {
  DINE_IN:         { tables: true,  bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: false },
  BAR_LOUNGE:      { tables: false, bar: true,  bar_inventory: true,  bottle_tracking: true,  food: false, delivery: false },
  BAR_WITH_DINING: { tables: true,  bar: true,  bar_inventory: true,  bottle_tracking: true,  food: true,  delivery: false },
  CAFE:            { tables: true,  bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: false },
  CLOUD_KITCHEN:   { tables: false, bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: true  },
};

// Computes the full set of enabled modules for a restaurant.
// Merges core modules (always on) with type-specific modules from the matrix.
// marketing and surveillance are always disabled by default.
// Returns a Record<string, boolean> suitable for storing in the Outlet.modules field.
export function computeEnabledModules(input: ModuleInput): Record<string, boolean> {
  const modules: Record<string, boolean> = {};
  for (const m of CORE_MODULES) modules[m] = true;

  const typeModules = MODULE_MATRIX[input.restaurantType] || MODULE_MATRIX['DINE_IN'];
  Object.assign(modules, typeModules);

  modules.marketing = false;
  modules.surveillance = false;

  return modules;
}

export const CORE_MODULES = ['dashboard', 'menu', 'orders', 'transactions', 'reports', 'captains', 'settings', 'payroll'] as const;

export interface ModuleInput {
  restaurantType: string;
}

const MODULE_MATRIX: Record<string, Record<string, boolean>> = {
  DINE_IN:         { tables: true,  bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: false },
  BAR_LOUNGE:      { tables: false, bar: true,  bar_inventory: true,  bottle_tracking: true,  food: false, delivery: false },
  BAR_WITH_DINING: { tables: true,  bar: true,  bar_inventory: true,  bottle_tracking: true,  food: true,  delivery: false },
  CAFE:            { tables: false, bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: false },
  CLOUD_KITCHEN:   { tables: false, bar: false, bar_inventory: false, bottle_tracking: false, food: true,  delivery: true  },
};

export function computeEnabledModules(input: ModuleInput): Record<string, boolean> {
  const modules: Record<string, boolean> = {};
  for (const m of CORE_MODULES) modules[m] = true;

  const typeModules = MODULE_MATRIX[input.restaurantType] || MODULE_MATRIX['DINE_IN'];
  Object.assign(modules, typeModules);

  modules.marketing = false;
  modules.surveillance = false;

  return modules;
}

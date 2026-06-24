export const CORE_MODULES = ['dashboard', 'tables', 'menu', 'orders', 'transactions', 'reports', 'captains', 'settings', 'payroll', 'marketing'] as const;

export interface ModuleInput {
  restaurantType: string;
  sectionNames: string[];   // section names entered in the Floor Plan onboarding step
  hasLiquorItems: boolean;  // true if any onboarding menu item is tagged LIQUOR
}

export function computeEnabledModules(input: ModuleInput): Record<string, boolean> {
  const modules: Record<string, boolean> = {};
  for (const m of CORE_MODULES) modules[m] = true;

  const wantsBar = input.restaurantType === 'BAR_AND_RESTAURANT' || input.restaurantType === 'BAR_LOUNGE' || input.hasLiquorItems;
  modules.bar = wantsBar;
  modules.inventory = wantsBar;
  modules.pricing = wantsBar;

  const venueKeywords = ['conference', 'pdr', 'rooms', 'gobox', 'go box'];
  modules.venue = wantsBar && input.sectionNames.some(n => venueKeywords.some(k => n.toLowerCase().includes(k)));

  modules.surveillance = false;

  return modules;
}

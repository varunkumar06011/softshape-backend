import crypto from "crypto";
import prisma from "../lib/prisma";

export const RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1;

export interface RuntimeSnapshot {
  snapshotVersion: string;
  schemaVersion: number;
  generatedAt: string;
  restaurantId: string;
  cursor: string;
  checksum: string;
  data: {
    outlet: Record<string, unknown>;
    organizationId: string;
    taxProfiles: unknown[];
    priceProfiles: unknown[];
    priceProfileItems: unknown[];
    venues: unknown[];
    floors: unknown[];
    sections: unknown[];
    tables: unknown[];
    categories: unknown[];
    menuItems: unknown[];
    menuVariants: unknown[];
    menuAddons: unknown[];
    comboComponents: unknown[];
    venuePrices: unknown[];
    venueAvailability: unknown[];
    users: unknown[];
    ledgerCategories: unknown[];
    employees: unknown[];
  };
  counts: Record<string, number>;
}

function normalizeForJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = normalizeForJson(record[key]);
      return result;
    }, {});
  }
  return value;
}

function checksum(data: RuntimeSnapshot["data"]): string {
  const canonical = JSON.stringify(normalizeForJson(data));
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function buildRuntimeSnapshot(restaurantId: string): Promise<RuntimeSnapshot> {
  const outlet = await prisma.outlet.findUnique({ where: { id: restaurantId } });
  if (!outlet) throw new Error("Outlet not found");

  const restaurantIds = [restaurantId];
  const [
    taxProfiles,
    priceProfiles,
    priceProfileItems,
    venues,
    floors,
    sections,
    tables,
    categories,
    menuItems,
    menuVariants,
    menuAddons,
    comboComponents,
    venuePrices,
    venueAvailability,
    users,
    ledgerCategories,
    employees,
    maxEvent,
  ] = await Promise.all([
    prisma.taxProfile.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.priceProfile.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.priceProfileItem.findMany({ where: { priceProfile: { restaurantId: { in: restaurantIds } } } }),
    prisma.venue.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.floor.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.section.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.table.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.category.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.menuItem.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.menuItemVariant.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.menuItemAddon.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.comboComponent.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.venuePrice.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.venueMenuItemAvailability.findMany({ where: { restaurantId: { in: restaurantIds } } }),
    prisma.user.findMany({
      where: { outletId: { in: restaurantIds } },
      select: { id: true, name: true, pin: true, role: true, isActive: true, outletId: true, permissions: true },
    }),
    prisma.ledgerCategory.findMany({
      where: { restaurantId: { in: restaurantIds } },
      select: { id: true, restaurantId: true, name: true, entryType: true, isActive: true },
    }),
    prisma.employee.findMany({
      where: { restaurantId: { in: restaurantIds }, isActive: true },
      select: { id: true, restaurantId: true, name: true, role: true, isActive: true },
    }),
    prisma.runtimeEvent.aggregate({
      where: { restaurantId, origin: "cloud" },
      _max: { cloudSequence: true },
    }),
  ]);

  // Never include the edge API key in a Runtime snapshot. It is a transport
  // credential, not operational configuration, and must not be copied into a
  // portable bootstrap payload.
  const { edgeApiKey: _edgeApiKey, ...safeOutlet } = outlet as typeof outlet & { edgeApiKey?: string | null };
  const data = {
    outlet: safeOutlet as Record<string, unknown>,
    organizationId: outlet.organizationId,
    taxProfiles,
    priceProfiles,
    priceProfileItems,
    venues,
    floors,
    sections,
    tables,
    categories,
    menuItems,
    menuVariants,
    menuAddons,
    comboComponents,
    venuePrices,
    venueAvailability,
    users,
    ledgerCategories,
    employees,
  };
  const normalizedData = normalizeForJson(data) as RuntimeSnapshot["data"];
  const cursor = (maxEvent._max.cloudSequence ?? BigInt(0)).toString();

  return {
    snapshotVersion: `runtime-snapshot-${cursor}`,
    schemaVersion: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    restaurantId,
    cursor,
    checksum: checksum(normalizedData),
    data: normalizedData,
    counts: {
      taxProfiles: taxProfiles.length,
      priceProfiles: priceProfiles.length,
      priceProfileItems: priceProfileItems.length,
      venues: venues.length,
      floors: floors.length,
      sections: sections.length,
      tables: tables.length,
      categories: categories.length,
      menuItems: menuItems.length,
      menuVariants: menuVariants.length,
      menuAddons: menuAddons.length,
      comboComponents: comboComponents.length,
      venuePrices: venuePrices.length,
      venueAvailability: venueAvailability.length,
      users: users.length,
      ledgerCategories: ledgerCategories.length,
      employees: employees.length,
    },
  };
}

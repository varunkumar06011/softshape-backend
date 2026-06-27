import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";

export interface TenantStore {
  restaurantId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

const modelsWithRestaurantId = new Set([
  "Category",
  "MenuItem",
  "Section",
  "Table",
  "Order",
  "Transaction",
  "DailyCounter",
  "CaptainAssignment",
  "InventoryItem",
  "InventoryTransaction",
  "DailyInventorySnapshot",
  "VenuePrice",
  "Employee",
  "PayrollRecord",
  "KitchenInventoryItem",
  "MenuItemRecipe",
  "InventoryDailyEntry",
  "PrintQueue",
  "Venue",
  "Floor",
  "PriceProfile",
  "PriceProfileItem",
  "TaxProfile",
]);

function hasRestaurantId(model: string): boolean {
  return modelsWithRestaurantId.has(model);
}

const connectionLimit = Number(process.env.PRISMA_CONNECTION_LIMIT) || 15;
const poolTimeout = Number(process.env.PRISMA_POOL_TIMEOUT) || 30;

const basePrismaInstance = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  datasources: {
    db: {
      // Prefer DIRECT_URL for the actual client connection: it avoids the Supabase
      // transaction pooler (port 6543) which can drop or refuse connections during
      // heavy local test runs. Migrations still use DIRECT_URL via Prisma's own logic.
      url:
        (process.env.DIRECT_URL || process.env.DATABASE_URL || "") +
        ((process.env.DIRECT_URL || process.env.DATABASE_URL)?.includes("?") ? "&" : "?") +
        `connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}`,
    },
  },
});

export const basePrisma = basePrismaInstance;

const prisma = basePrismaInstance.$extends({
  query: {
    $allModels: {
      async findUnique({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async findUniqueOrThrow({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async findFirst({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async findFirstOrThrow({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async findMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async update({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async updateMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async delete({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async deleteMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async count({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async aggregate({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async create({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).data = { ...(args as any).data, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
      async createMany({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          const data = Array.isArray((args as any).data) ? (args as any).data : [(args as any).data];
          (args as any).data = data.map((d: any) => ({ ...d, restaurantId: ctx.restaurantId }));
        }
        return query(args);
      },
      async upsert({ args, query, model }) {
        const ctx = tenantStorage.getStore();
        if (ctx && hasRestaurantId(model)) {
          (args as any).where = { ...(args as any).where, restaurantId: ctx.restaurantId };
          (args as any).create = { ...(args as any).create, restaurantId: ctx.restaurantId };
          (args as any).update = { ...(args as any).update, restaurantId: ctx.restaurantId };
        }
        return query(args);
      },
    },
  },
});

export default prisma;

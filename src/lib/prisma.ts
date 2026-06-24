import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";

export interface TenantStore {
  restaurantId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

const modelsWithRestaurantId = new Set([
  "User",
  "Category",
  "MenuItem",
  "Section",
  "Table",
  "Order",
  "Transaction",
  "DailyCounter",
  "CaptainAssignment",
  "CaptainTarget",
  "InventoryItem",
  "InventoryTransaction",
  "DailyInventorySnapshot",
  "VenuePrice",
]);

function hasRestaurantId(model: string): boolean {
  return modelsWithRestaurantId.has(model);
}

const connectionLimit = Number(process.env.PRISMA_CONNECTION_LIMIT) || 30;
const poolTimeout = Number(process.env.PRISMA_POOL_TIMEOUT) || 30;

const basePrismaInstance = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  datasources: {
    db: {
      url:
        (process.env.DATABASE_URL || "") +
        (process.env.DATABASE_URL?.includes("?") ? "&" : "?") +
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
    },
  },
});

export default prisma;

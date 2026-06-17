import { PrismaClient } from "@prisma/client";

// Single shared instance for the entire process.
// Prevents the 14-separate-pool problem that exhausts Supabase connections.
// If using Supabase PgBouncer (port 6543), connection_limit can be higher (e.g. 50–100)
// because PgBouncer multiplexes many client connections into fewer DB connections.
const connectionLimit = Number(process.env.PRISMA_CONNECTION_LIMIT) || 30;
const poolTimeout = Number(process.env.PRISMA_POOL_TIMEOUT) || 30;
const prisma = new PrismaClient({
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

export default prisma;

import { PrismaClient } from "@prisma/client";

// Single shared instance for the entire process.
// Prevents the 14-separate-pool problem that exhausts Supabase connections.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  datasources: {
    db: {
      url:
        (process.env.DATABASE_URL || "") +
        (process.env.DATABASE_URL?.includes("?") ? "&" : "?") +
        "connection_limit=20&pool_timeout=30",
    },
  },
});

export default prisma;

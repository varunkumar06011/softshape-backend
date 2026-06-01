import { PrismaClient } from "@prisma/client";

// Single shared instance for the entire process.
// Prevents the 14-separate-pool problem that exhausts Supabase connections.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

export default prisma;

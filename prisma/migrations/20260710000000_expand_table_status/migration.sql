-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Expand TableStatus enum with PREPARING, READY, BILLING
-- ─────────────────────────────────────────────────────────────────────────────
-- Adds finer-grained table status values so `status` can be the single source
-- of truth. The `workflowStatus` column is kept for now as a derived/read-only
-- field for backward compatibility — it will be removed in a follow-up migration
-- once all code paths are verified to use `status` exclusively.
--
-- This migration is additive-only: no existing data is modified or deleted.
-- ─────────────────────────────────────────────────────────────────────────────

-- PostgreSQL: ALTER TYPE ... ADD VALUE is additive and safe.
-- Each ADD VALUE must be in its own statement (Postgres limitation).
ALTER TYPE "TableStatus" ADD VALUE IF NOT EXISTS 'PREPARING';
ALTER TYPE "TableStatus" ADD VALUE IF NOT EXISTS 'READY';
ALTER TYPE "TableStatus" ADD VALUE IF NOT EXISTS 'BILLING';

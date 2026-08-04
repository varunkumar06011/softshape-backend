// ─────────────────────────────────────────────────────────────────────────────
// Print Queue — Observability-only buffer for print jobs (R4 / ADR-001)
// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURAL INVARIANT: Cloud must never retry or re-deliver print jobs.
// The runtime (edge server) SQLite queue is the sole retry owner.
// If code running in the cloud attempts to retry a print job, it's a bug.
//
// This module stores print jobs for telemetry and observability only.
// Jobs are buffered on emit and marked PRINTED/FAILED on ack, but the cloud
// NEVER re-delivers them on reconnect. The runtime handles all retry logic.
//
// TTL: PRINTED rows are cleaned up after 1 hour, PENDING/FAILED after 24 hours.
//
// Usage:
//   await bufferPrintJob(restaurantId, { eventId, ...kotData });  // store job
//   await markEventIdPrinted(eventId);                             // acknowledge success
//   await markEventIdFailed(eventId, 'Printer offline');           // acknowledge failure
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "./prisma";
import logger from "./logger";

// Buffers a print job in the PrintQueue table. Uses upsert so duplicate eventId
// values update the existing record rather than failing. Sets status to PENDING.
// R4: This is observability-only — the job is stored for telemetry but never
// re-delivered by the cloud. The runtime SQLite queue handles all retry logic.
export async function bufferPrintJob(restaurantId: string, payload: any): Promise<void> {
  const eventId = payload.eventId || String(Date.now());
  try {
    await prisma.printQueue.upsert({
      where: { eventId },
      create: { restaurantId, eventId, payload, status: 'PENDING' },
      update: { payload, status: 'PENDING', printedAt: null },
    });
  } catch (err) {
    logger.error({ err }, '[PrintQueue] bufferPrintJob failed');
  }
}

// Marks a print job as PRINTED. Called when PrintStation/Agent sends 'print:ack'
// with a success status. Uses updateMany in case of duplicate eventId rows.
export async function markEventIdPrinted(eventId: string): Promise<void> {
  try {
    await prisma.printQueue.updateMany({
      where: { eventId },
      data: { status: 'PRINTED', printedAt: new Date() },
    });
  } catch (err) {
    logger.error({ err }, '[PrintQueue] markEventIdPrinted failed');
  }
}

// Marks a print job as FAILED with an optional error message.
// Called when PrintStation/Agent sends 'print:ack' with status 'failed'.
// Logs the failure for debugging.
export async function markEventIdFailed(eventId: string, errorMsg?: string): Promise<void> {
  try {
    await prisma.printQueue.updateMany({
      where: { eventId },
      data: { status: 'FAILED', printedAt: new Date(), errorMsg: errorMsg || null },
    });
    if (errorMsg) {
      logger.warn({ eventId, error: errorMsg }, '[PrintQueue] Print job marked as FAILED');
    }
  } catch (err) {
    logger.error({ err }, '[PrintQueue] markEventIdFailed failed');
  }
}

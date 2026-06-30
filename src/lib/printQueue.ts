// ─────────────────────────────────────────────────────────────────────────────
// Print Queue — Buffered print job delivery for PrintStation/Agent reconnect
// ─────────────────────────────────────────────────────────────────────────────
// Stores print jobs (KOTs, bills) in the database so they can be re-delivered
// if the PrintStation or Windows Print Agent disconnects and reconnects.
// Jobs remain in PENDING status until the PrintStation/Agent acknowledges them
// via the socket 'print:ack' event, at which point they're marked PRINTED or FAILED.
//
// TTL: PENDING jobs are retrievable for 3 minutes after creation.
// After that, getRecentPrintJobs() won't return them (they're considered stale).
// The periodic cleanup in index.ts deletes PRINTED rows after 1 hour and
// PENDING/FAILED rows after 24 hours.
//
// Usage:
//   await bufferPrintJob(restaurantId, { eventId, ...kotData });  // store job
//   const jobs = await getRecentPrintJobs(restaurantId);           // retrieve pending
//   await markEventIdPrinted(eventId);                             // acknowledge success
//   await markEventIdFailed(eventId, 'Printer offline');           // acknowledge failure
// ─────────────────────────────────────────────────────────────────────────────

import prisma from "./prisma";
import logger from "./logger";

// How long a print job stays retrievable for re-delivery (3 minutes)
const PRINT_JOB_TTL_MS = 10 * 60_000; // 10 minutes — covers longer agent disconnections during busy service

// Buffers a print job in the PrintQueue table. Uses upsert so duplicate eventId
// values update the existing record rather than failing. Sets status to PENDING.
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

// Retrieves all PENDING print jobs for a restaurant within the TTL window.
// Called when PrintStation or Agent reconnects via socket 'join:print' or 'agent:join'.
// Returns jobs ordered by creation time (oldest first) so they're printed in order.
//
// Jobs where payload.localPrinted === true are skipped and marked PRINTED —
// these were already printed via the local Print Agent HTTP endpoint, so
// re-delivering them would cause duplicate prints.
export async function getRecentPrintJobs(restaurantId: string): Promise<Array<{ payload: any; ts: number; eventId: string }>> {
  try {
    const cutoff = new Date(Date.now() - PRINT_JOB_TTL_MS);
    const rows = await prisma.printQueue.findMany({
      where: { restaurantId, status: 'PENDING', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'asc' },
    });

    const deliverable: Array<{ payload: any; ts: number; eventId: string }> = [];

    for (const r of rows) {
      if ((r.payload as any)?.localPrinted === true) {
        // Already printed locally — mark as PRINTED, don't re-deliver
        await markEventIdPrinted(r.eventId).catch(() => {});
        continue;
      }
      deliverable.push({ payload: r.payload, ts: r.createdAt.getTime(), eventId: r.eventId });
    }

    return deliverable;
  } catch (err) {
    logger.error({ err }, '[PrintQueue] getRecentPrintJobs failed');
    return [];
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
      data: { status: 'FAILED', printedAt: new Date() },
    });
    if (errorMsg) {
      logger.warn({ eventId, error: errorMsg }, '[PrintQueue] Print job marked as FAILED');
    }
  } catch (err) {
    logger.error({ err }, '[PrintQueue] markEventIdFailed failed');
  }
}

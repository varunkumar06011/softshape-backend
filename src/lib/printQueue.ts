import prisma from "./prisma";
import logger from "./logger";

const PRINT_JOB_TTL_MS = 3 * 60_000; // 3 minutes — covers longer PrintStation reconnections

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

export async function getRecentPrintJobs(restaurantId: string): Promise<Array<{ payload: any; ts: number; eventId: string }>> {
  try {
    const cutoff = new Date(Date.now() - PRINT_JOB_TTL_MS);
    const rows = await prisma.printQueue.findMany({
      where: { restaurantId, status: 'PENDING', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => ({ payload: r.payload, ts: r.createdAt.getTime(), eventId: r.eventId }));
  } catch (err) {
    logger.error({ err }, '[PrintQueue] getRecentPrintJobs failed');
    return [];
  }
}

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

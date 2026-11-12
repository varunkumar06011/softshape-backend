import { describe, it, expect } from 'vitest';
import { recordEdgeErrorReports, MAX_REPORTS_PER_DAY, MAX_REPORTS_PER_REQUEST } from './edgeErrorReports';

function fakeDb(alreadyToday = 0) {
  const stored: any[] = [];
  return {
    stored,
    auditLog: {
      count: async () => alreadyToday,
      createMany: async ({ data }: any) => { stored.push(...data); },
    },
  };
}

describe('recordEdgeErrorReports', () => {
  it('stores errors as EDGE_ERROR and refused KOTs as EDGE_EVENT, with the restaurant and device', async () => {
    const db = fakeDb();
    const result = await recordEdgeErrorReports(db, {
      restaurantId: 'r1', deviceId: 'pc-1', appVersion: '24.0.20',
      reports: [
        { kind: 'log:printer', severity: 'error', message: 'Printer offline', count: 3, firstAt: 1, lastAt: 5, context: { printer: 'Kitchen' } },
        { kind: 'kot_refused', severity: 'info', message: 'KOT refused', count: 1, firstAt: 2, lastAt: 2, context: null },
      ],
    });

    expect(result).toEqual({ accepted: 2, dropped: 0 });
    expect(db.stored[0]).toMatchObject({ restaurantId: 'r1', action: 'EDGE_ERROR', entityType: 'edge', entityId: 'pc-1' });
    expect(db.stored[0].metadata).toMatchObject({ kind: 'log:printer', count: 3, appVersion: '24.0.20', context: { printer: 'Kitchen' } });
    expect(db.stored[1].action).toBe('EDGE_EVENT');
  });

  it('keeps messages short and ignores junk', async () => {
    const db = fakeDb();
    await recordEdgeErrorReports(db, { restaurantId: 'r1', reports: [{ message: 'x'.repeat(5000), kind: 'k', count: 'abc', context: 'not an object' }, null] });

    expect(db.stored[0].metadata.message).toHaveLength(500);
    expect(db.stored[0].metadata.count).toBe(1);
    expect(db.stored[0].metadata.context).toBeNull();
    expect(db.stored).toHaveLength(2);
  });

  it('takes at most 50 reports per request', async () => {
    const db = fakeDb();
    const reports = Array.from({ length: 80 }, (_, i) => ({ kind: 'k', message: `m${i}` }));

    const result = await recordEdgeErrorReports(db, { restaurantId: 'r1', reports });

    expect(result.accepted).toBe(MAX_REPORTS_PER_REQUEST);
  });

  it('stops storing once a restaurant has sent its daily limit, so a looping PC cannot fill the database', async () => {
    const db = fakeDb(MAX_REPORTS_PER_DAY - 1);

    const result = await recordEdgeErrorReports(db, { restaurantId: 'r1', reports: [{ message: 'a' }, { message: 'b' }, { message: 'c' }] });

    expect(result).toEqual({ accepted: 1, dropped: 2 });
  });

  it('does nothing for an empty request', async () => {
    expect(await recordEdgeErrorReports(fakeDb(), { restaurantId: 'r1', reports: [] })).toEqual({ accepted: 0, dropped: 0 });
  });
});

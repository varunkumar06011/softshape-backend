/**
 * Delete POS sales data dated BEFORE a cutoff (default 2026-10-01, IST).
 * Everything on/after the cutoff is kept.
 *
 * DRY RUN by default — prints exactly what would be deleted, changes nothing.
 *
 *   node scripts/delete-sales-before.js                              # dry run, all outlets
 *   node scripts/delete-sales-before.js --restaurant <outletId>      # dry run, one outlet
 *   node scripts/delete-sales-before.js --execute                    # actually delete (single DB transaction)
 *   node scripts/delete-sales-before.js --cutoff 2026-10-01 --execute
 *
 * TAKE A BACKUP FIRST:  pg_dump "$DIRECT_URL" -Fc -f before-sales-cleanup.dump
 *
 * Deleted (date < cutoff):
 *   Transaction          txnDate < cutoff (or txnDate empty and paidAt < cutoff IST)
 *   Order                createdAt < cutoff IST and no kept Transaction
 *     -> cascades: OrderItem, Kot, KotItem, OrderDeductionLog, BarDeductionLog, OrderConflict
 *   XReport              reportDate < cutoff
 *   DailyCounter         counterDate < cutoff
 *   AdditionalOutletSale saleDate < cutoff
 *   ProcessedRequest     createdAt < cutoff IST
 *   PrintQueue           createdAt < cutoff IST
 *
 * NOT touched: menu, tables, users, inventory (stock levels / movements / snapshots),
 * bar daily records, expenditures, balance sheets, payroll, vendors, Transaction_backup_* tables.
 */
const { PrismaClient } = require('@prisma/client');

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const EXECUTE = args.includes('--execute');
const CUTOFF = arg('--cutoff') || '2026-10-01';
const RESTAURANT = arg('--restaurant') || null;

if (!/^\d{4}-\d{2}-\d{2}$/.test(CUTOFF)) {
  console.error(`Invalid --cutoff "${CUTOFF}", expected YYYY-MM-DD`);
  process.exit(1);
}
// Midnight IST (UTC+05:30) of the cutoff date, as a UTC instant.
const CUTOFF_TS = new Date(`${CUTOFF}T00:00:00+05:30`);
// Prisma stores DateTime as UTC in "timestamp(3)" columns; pass a plain UTC string (no session-TZ dependence).
const CUTOFF_TS_SQL = CUTOFF_TS.toISOString().replace('T', ' ').replace('Z', '');

const prisma = new PrismaClient();

// Every statement takes ($1 = cutoff date string, $2 = cutoff timestamp, $3 = restaurantId or NULL).
const R = (col = '"restaurantId"') => `($3::text IS NULL OR ${col} = $3::text)`;

const TXN_WHERE = `
  ${R('t."restaurantId"')}
  AND ( (t."txnDate" <> '' AND t."txnDate" < $1::text)
     OR (t."txnDate" = ''  AND t."paidAt" < $2::timestamp) )`;

// Orders before cutoff that have no transaction on/after the cutoff (those are kept with their bill).
const ORDER_WHERE = `
  ${R('o."restaurantId"')}
  AND o."createdAt" < $2::timestamp
  AND NOT EXISTS (
    SELECT 1 FROM "Transaction" k
    WHERE k."orderId" = o.id
      AND NOT ( (k."txnDate" <> '' AND k."txnDate" < $1::text)
             OR (k."txnDate" = ''  AND k."paidAt" < $2::timestamp) ))`;

const STEPS = [
  // Transaction.orderId -> Order has no ON DELETE CASCADE, so transactions go first.
  { table: 'Transaction', count: `SELECT count(*) FROM "Transaction" t WHERE ${TXN_WHERE}`,
    del: `DELETE FROM "Transaction" t WHERE ${TXN_WHERE}` },
  { table: 'OrderItem (cascade)', count: `SELECT count(*) FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'Kot (cascade)', count: `SELECT count(*) FROM "Kot" x JOIN "Order" o ON o.id = x."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'KotItem (cascade)', count: `SELECT count(*) FROM "KotItem" ki JOIN "Kot" x ON x.id = ki."kotId" JOIN "Order" o ON o.id = x."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'OrderDeductionLog (cascade)', count: `SELECT count(*) FROM "OrderDeductionLog" d JOIN "Order" o ON o.id = d."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'BarDeductionLog (cascade)', count: `SELECT count(*) FROM "BarDeductionLog" d JOIN "Order" o ON o.id = d."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'OrderConflict (cascade)', count: `SELECT count(*) FROM "OrderConflict" c JOIN "Order" o ON o.id = c."orderId" WHERE ${ORDER_WHERE}` },
  { table: 'Order', count: `SELECT count(*) FROM "Order" o WHERE ${ORDER_WHERE}`,
    del: `DELETE FROM "Order" o WHERE ${ORDER_WHERE}` },
  { table: 'XReport', count: `SELECT count(*) FROM "XReport" WHERE ${R()} AND "reportDate" < $1::text`,
    del: `DELETE FROM "XReport" WHERE ${R()} AND "reportDate" < $1::text` },
  { table: 'DailyCounter', count: `SELECT count(*) FROM "DailyCounter" WHERE ${R()} AND "counterDate" < $1::text`,
    del: `DELETE FROM "DailyCounter" WHERE ${R()} AND "counterDate" < $1::text` },
  { table: 'AdditionalOutletSale', count: `SELECT count(*) FROM "additional_outlet_sales" WHERE ${R()} AND "saleDate" < $1::text`,
    del: `DELETE FROM "additional_outlet_sales" WHERE ${R()} AND "saleDate" < $1::text` },
  { table: 'ProcessedRequest', count: `SELECT count(*) FROM "ProcessedRequest" WHERE ${R()} AND "createdAt" < $2::timestamp`,
    del: `DELETE FROM "ProcessedRequest" WHERE ${R()} AND "createdAt" < $2::timestamp` },
  { table: 'PrintQueue', count: `SELECT count(*) FROM "PrintQueue" WHERE ${R()} AND "createdAt" < $2::timestamp`,
    del: `DELETE FROM "PrintQueue" WHERE ${R()} AND "createdAt" < $2::timestamp` },
];

const params = [CUTOFF, CUTOFF_TS_SQL, RESTAURANT];

async function summary(label) {
  const [t] = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n, coalesce(sum(coalesce("grandTotal", amount)),0)::text AS total,
            min("txnDate") AS first, max("txnDate") AS last
     FROM "Transaction" t WHERE ($1::text IS NULL OR t."restaurantId" = $1::text) AND t."status" = 'COMPLETED'`, RESTAURANT);
  console.log(`${label}: ${t.n} completed transactions, total ${t.total}, txnDate ${t.first} .. ${t.last}`);
}

(async () => {
  console.log(`Mode:       ${EXECUTE ? 'EXECUTE (will delete)' : 'DRY RUN (no changes)'}`);
  console.log(`Cutoff:     delete < ${CUTOFF} (IST)  = < ${CUTOFF_TS.toISOString()} UTC; keep ${CUTOFF} .. today`);
  console.log(`Outlet:     ${RESTAURANT || 'ALL outlets'}\n`);

  await summary('Before');

  const openOrders = await prisma.$queryRawUnsafe(
    `SELECT o.status::text AS status, count(*)::int AS n FROM "Order" o WHERE ${ORDER_WHERE} GROUP BY 1 ORDER BY 1`, ...params);
  console.log('\nOrders to delete by status:', openOrders.map((r) => `${r.status}=${r.n}`).join(', ') || 'none');

  console.log('\nRows to delete:');
  for (const s of STEPS) {
    const [r] = await prisma.$queryRawUnsafe(s.count, ...params);
    console.log(`  ${s.table.padEnd(28)} ${String(r.count).padStart(8)}`);
  }

  if (!EXECUTE) {
    console.log('\nDry run only. Re-run with --execute to delete (after taking a pg_dump backup).');
    return;
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const out = {};
    for (const s of STEPS.filter((x) => x.del)) {
      out[s.table] = await tx.$executeRawUnsafe(s.del, ...params);
    }
    return out;
  }, { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 });

  console.log('\nDeleted:');
  for (const [k, v] of Object.entries(deleted)) console.log(`  ${k.padEnd(28)} ${String(v).padStart(8)}`);
  console.log('');
  await summary('After');
})()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

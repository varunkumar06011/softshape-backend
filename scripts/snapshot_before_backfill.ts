// @ts-nocheck
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  const snapshotsDir = path.resolve(__dirname, '..', 'snapshots');
  fs.mkdirSync(snapshotsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const cashiers = await prisma.user.findMany({
    where: { role: 'CASHIER', isActive: true },
    select: { id: true, name: true, permissions: true }
  });
  const cashiersPath = path.join(snapshotsDir, `cashiers_${timestamp}.json`);
  fs.writeFileSync(cashiersPath, JSON.stringify(cashiers, null, 2));

  const transactions = await prisma.transaction.findMany({
    where: { platform: null },
    select: { id: true, orderId: true, paidAt: true }
  });
  const transactionsPath = path.join(snapshotsDir, `transactions_${timestamp}.json`);
  fs.writeFileSync(transactionsPath, JSON.stringify(transactions, null, 2));

  console.log(`snapshots written: ${cashiers.length} cashiers, ${transactions.length} transactions`);
  console.log(`  ${cashiersPath}`);
  console.log(`  ${transactionsPath}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

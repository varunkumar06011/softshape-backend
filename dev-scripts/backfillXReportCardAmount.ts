import prisma from '../src/lib/prisma';
import { basePrisma } from '../src/lib/prisma';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

async function backfillXReportCardAmount() {
  const reports = await basePrisma.xReport.findMany();

  console.log(`Found ${reports.length} X-Reports to check.`);

  let updated = 0;
  let skipped = 0;

  for (const report of reports) {
    const rows = await basePrisma.transaction.groupBy({
      by: ['method'],
      where: {
        restaurantId: report.restaurantId,
        txnDate: report.reportDate,
      },
      _sum: { grandTotal: true, amount: true },
    });

    let cashSales = 0;
    let cardSales = 0;
    for (const row of rows) {
      const value = Number(row._sum?.grandTotal ?? row._sum?.amount ?? 0);
      if (row.method === 'CASH') {
        cashSales += value;
      } else if (row.method === 'CARD') {
        cardSales += value;
      }
    }

    cashSales = round2(cashSales);
    cardSales = round2(cardSales);

    const storedCash = round2(Number(report.cashAmount));
    const storedCard = round2(Number(report.cardAmount));

    if (storedCash !== cashSales || storedCard !== cardSales) {
      console.log(
        `[Fix] ${report.reportDate} restaurant=${report.restaurantId}: ` +
        `cash ${storedCash} -> ${cashSales}, card ${storedCard} -> ${cardSales}`
      );

      await basePrisma.xReport.update({
        where: { id: report.id },
        data: {
          cashAmount: cashSales,
          cardAmount: cardSales,
        },
      });
      updated++;
    } else {
      skipped++;
    }
  }

  console.log(`\nDone. Updated ${updated} X-Reports, ${skipped} were already correct.`);
}

backfillXReportCardAmount()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

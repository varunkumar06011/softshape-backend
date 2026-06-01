import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type BackfillTotals = {
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  cgst: number;
  sgst: number;
  grandTotal: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

async function calculateOrderTotals(orderId: string): Promise<BackfillTotals> {
  const items = await prisma.orderItem.findMany({
    where: {
      orderId,
      removedFromBill: false,
    },
    select: {
      price: true,
      quantity: true,
      menuType: true,
    },
  });

  let foodSubtotal = 0;
  let liquorSubtotal = 0;

  for (const item of items) {
    const lineTotal = Number(item.price) * item.quantity;
    if (item.menuType === "LIQUOR") {
      liquorSubtotal += lineTotal;
    } else {
      foodSubtotal += lineTotal;
    }
  }

  const subtotal = roundMoney(foodSubtotal + liquorSubtotal);
  const discountPercent = 0;
  const discountAmount = 0;
  const cgst = roundMoney(foodSubtotal * 0.025);
  const sgst = roundMoney(foodSubtotal * 0.025);
  const grandTotal = roundMoney(subtotal + cgst + sgst);

  return {
    subtotal,
    discountPercent,
    discountAmount,
    cgst,
    sgst,
    grandTotal,
  };
}

async function updateTransaction(transactionId: string, totals: BackfillTotals) {
  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      amount: new Prisma.Decimal(totals.grandTotal),
      subtotal: new Prisma.Decimal(totals.subtotal),
      discountPercent: totals.discountPercent > 0 ? new Prisma.Decimal(totals.discountPercent) : null,
      discountAmount: totals.discountAmount > 0 ? new Prisma.Decimal(totals.discountAmount) : null,
      cgst: new Prisma.Decimal(totals.cgst),
      sgst: new Prisma.Decimal(totals.sgst),
      grandTotal: new Prisma.Decimal(totals.grandTotal),
    },
  });
}

async function main() {
  console.log("[BackfillTransactionTotals] Starting...");

  const transactions = await prisma.transaction.findMany({
    where: { grandTotal: null },
    select: {
      id: true,
      orderId: true,
      amount: true,
    },
    orderBy: { paidAt: "asc" },
  });

  const total = transactions.length;
  let updated = 0;
  let failed = 0;

  for (const transaction of transactions) {
    try {
      const totals = transaction.orderId
        ? await calculateOrderTotals(transaction.orderId)
        : {
            subtotal: Number(transaction.amount),
            discountPercent: 0,
            discountAmount: 0,
            cgst: 0,
            sgst: 0,
            grandTotal: Number(transaction.amount),
          };

      await updateTransaction(transaction.id, totals);
      updated += 1;
      console.log(`Updated ${updated} / ${total} transactions`);
    } catch (error) {
      failed += 1;
      console.error(
        `[BackfillTransactionTotals] Failed transaction ${transaction.id}:`,
        error
      );
    }
  }

  console.log("[BackfillTransactionTotals] Summary:");
  console.log(`Total processed: ${total}`);
  console.log(`Total updated: ${updated}`);
  console.log(`Total failed: ${failed}`);
}

main()
  .catch((error) => {
    console.error("[BackfillTransactionTotals] Fatal error:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

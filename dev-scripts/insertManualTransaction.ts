/**
 * One-off script: Insert a manual transaction record for restaurant Z3695J
 * Bill No 8, Table 16, Date 07/07/2026, Time 03:12 PM IST
 *
 * Usage: npx tsx dev-scripts/insertManualTransaction.ts
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const RESTAURANT_ID = 'Z3695J';
const TXN_DATE = '2026-07-07';
// 03:12 PM IST = 09:42 UTC
const PAID_AT = new Date('2026-07-07T09:42:00.000Z');

const ITEMS = [
  { name: 'Gongura Chicken Biryani',       quantity: 1,  price: 330,  menuType: 'FOOD'   },
  { name: 'Raju Gari Chicken Biryani',      quantity: 1,  price: 410,  menuType: 'FOOD'   },
  { name: 'Jeera Rice',                     quantity: 1,  price: 260,  menuType: 'FOOD'   },
  { name: 'Today Spl Indian B/L',           quantity: 1,  price: 410,  menuType: 'FOOD'   },
  { name: 'Chicken Hot and Sour Soup',      quantity: 2,  price: 170,  menuType: 'FOOD'   },
  { name: 'Boiled Palli Masala',            quantity: 1,  price: 179,  menuType: 'FOOD'   },
  { name: 'Royal Challenge Whiskey',        quantity: 3,  price: 61,   menuType: 'LIQUOR' },
  { name: 'Royal Stag',                     quantity: 21, price: 61,   menuType: 'LIQUOR' },
  { name: 'Chicken Manchow Soup',           quantity: 2,  price: 170,  menuType: 'FOOD'   },
  { name: 'Water Bottle 1 Ltr',             quantity: 4,  price: 25,   menuType: 'FOOD'   },
];

const SUBTOTAL       = 3833;
const DISCOUNT_PCT   = 10;
const DISCOUNT_AMT   = 383;
const CGST           = 51;
const SGST           = 51;
const GRAND_TOTAL    = 3552;
const ROUND_OFF      = 0;
const TABLE_NUMBER   = 16;
const BILL_NUMBER    = '8';
const PAYMENT_METHOD = 'CASH';

async function main() {
  console.log(`Inserting manual transaction for restaurant ${RESTAURANT_ID}...`);

  const result = await prisma.$transaction(async (tx) => {
    // Atomically get the next txnNumber for the day
    const counter = await tx.dailyCounter.upsert({
      where: { restaurantId_counterDate: { restaurantId: RESTAURANT_ID, counterDate: TXN_DATE } },
      update: { txnCount: { increment: 1 } },
      create: { restaurantId: RESTAURANT_ID, counterDate: TXN_DATE, txnCount: 1 },
      select: { txnCount: true },
    });

    const txnNumber = counter.txnCount;
    console.log(`  Assigned txnNumber: ${txnNumber}`);

    const txn = await tx.transaction.create({
      data: {
        restaurantId:    RESTAURANT_ID,
        tableNumber:     TABLE_NUMBER,
        billNumber:      BILL_NUMBER,
        amount:          new Prisma.Decimal(GRAND_TOTAL),
        method:          PAYMENT_METHOD,
        itemCount:       ITEMS.length,
        items:           ITEMS as any,
        subtotal:        new Prisma.Decimal(SUBTOTAL),
        discountPercent: new Prisma.Decimal(DISCOUNT_PCT),
        discountAmount:  new Prisma.Decimal(DISCOUNT_AMT),
        cgst:            new Prisma.Decimal(CGST),
        sgst:            new Prisma.Decimal(SGST),
        grandTotal:      new Prisma.Decimal(GRAND_TOTAL),
        roundOff:        new Prisma.Decimal(ROUND_OFF),
        tipAmount:       new Prisma.Decimal(0),
        txnNumber,
        txnDate:         TXN_DATE,
        paidAt:          PAID_AT,
        platform:        'DINE_IN',
      },
    });

    return txn;
  });

  console.log('\n✅ Transaction inserted successfully:');
  console.log(`   ID:          ${result.id}`);
  console.log(`   txnNumber:   ${result.txnNumber}`);
  console.log(`   billNumber:  ${result.billNumber}`);
  console.log(`   tableNumber: ${result.tableNumber}`);
  console.log(`   grandTotal:  ₹${result.grandTotal}`);
  console.log(`   paidAt:      ${result.paidAt.toISOString()} (UTC) = ${result.paidAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
}

main()
  .catch((e) => {
    console.error('❌ Error inserting transaction:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

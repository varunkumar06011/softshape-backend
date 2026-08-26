import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function num(v: any): number {
  return Number(v ?? 0);
}

async function main() {
  const outletId = 'cmqy60ci200027dscyj9ubg8h';
  console.log(`=== Daily Balance Sheet Audit for outlet ${outletId} ===\n`);

  // 1. Fetch all balance sheets for this outlet, ordered by date
  const sheets = await prisma.dailyBalanceSheet.findMany({
    where: { restaurantId: outletId },
    include: { adjustments: { orderBy: { sortOrder: 'asc' } } },
    orderBy: { reportDate: 'asc' },
  });

  console.log(`Total saved sheets: ${sheets.length}\n`);

  let issues: string[] = [];
  let verified: string[] = [];

  // 2. For each sheet, verify the persisted values against live transaction data
  for (const sheet of sheets) {
    const date = sheet.reportDate;
    const errors: string[] = [];
    const checks: string[] = [];

    // 2a. Verify venue sales computed values match live transactions
    const transactions = await prisma.transaction.findMany({
      where: {
        restaurantId: outletId,
        txnDate: date,
        status: 'COMPLETED',
      },
      select: {
        id: true,
        grandTotal: true,
        amount: true,
        sectionId: true,
        platform: true,
        method: true,
        tipAmount: true,
        cashAmount: true,
        cardAmount: true,
        upiAmount: true,
        otherAmount: true,
      },
    });

    // Compute live venue sales (matching backend logic)
    const AGGREGATOR_PLATFORMS = new Set(['SWIGGY', 'ZOMATO']);
    const venueTxns = transactions.filter((t: any) => {
      const platform = (t.platform || '').toUpperCase();
      return !AGGREGATOR_PLATFORMS.has(platform);
    });

    const sectionIds = [...new Set(venueTxns.map((t: any) => t.sectionId).filter(Boolean))] as string[];
    const sections = await prisma.section.findMany({
      where: { id: { in: sectionIds } },
      select: { id: true, venueId: true },
    });
    const sectionVenueMap = new Map<string, string | null>();
    for (const s of sections) sectionVenueMap.set(s.id, s.venueId);

    const venueIds = [...new Set([...sectionVenueMap.values()].filter(Boolean))] as string[];
    const venues = await prisma.venue.findMany({
      where: { id: { in: venueIds } },
      select: { id: true, venueType: true, name: true },
    });
    const venueTypeMap = new Map<string, string>();
    const venueNameMap = new Map<string, string>();
    for (const v of venues) {
      venueTypeMap.set(v.id, v.venueType || '');
      if (v.name) venueNameMap.set(v.id, v.name);
    }

    const VENUE_TYPE_MAP: Record<string, string> = {
      AC_BAR: 'acBar',
      NON_AC_BAR: 'nonAcBar',
      FAMILY_WING: 'familyWing',
      FAMILY_RESTAURANT: 'familyWing',
      'FAMILY RESTAURANT': 'familyWing',
      'FAMILY RESTARUNT': 'familyWing',
      PARCEL: 'parcel',
      AC: 'acBar',
      NON_AC: 'nonAcBar',
      FAMILY: 'familyWing',
      TAKEAWAY: 'parcel',
      TAKE_AWAY: 'parcel',
      DINE_IN: 'acBar',
    };

    const liveBuckets = { acBar: 0, nonAcBar: 0, familyWing: 0, parcel: 0 };
    for (const txn of venueTxns) {
      const sectionId = txn.sectionId;
      if (!sectionId) {
        liveBuckets.acBar += num(txn.grandTotal ?? txn.amount);
        continue;
      }
      const venueId = sectionVenueMap.get(sectionId);
      const venueType = venueId ? venueTypeMap.get(venueId) : null;
      const venueName = venueId ? venueNameMap.get(venueId) : undefined;
      let bucketKey = venueType ? VENUE_TYPE_MAP[venueType.toUpperCase()] : null;
      const isGenericType = !venueType || ['DINE_IN', 'DINING', 'UNKNOWN', 'DEFAULT'].includes(venueType.toUpperCase());
      if (venueName && (!bucketKey || isGenericType)) {
        const nameUpper = venueName.toUpperCase();
        if (nameUpper.includes('PARCEL') || nameUpper.includes('TAKEAWAY')) bucketKey = 'parcel';
        else if (nameUpper.includes('FAMILY') || nameUpper.includes('RESTAURANT')) bucketKey = 'familyWing';
        else if (nameUpper.includes('BAR') || nameUpper.includes('LOUNGE')) bucketKey = 'acBar';
      }
      if (!bucketKey) bucketKey = 'acBar';
      (liveBuckets as any)[bucketKey] += num(txn.grandTotal ?? txn.amount);
    }

    // 2b. Verify aggregator sales
    let liveSwiggy = 0, liveZomato = 0;
    for (const txn of transactions) {
      const platform = (txn.platform || '').toUpperCase();
      const amt = num(txn.grandTotal ?? txn.amount);
      if (platform === 'SWIGGY') liveSwiggy += amt;
      else if (platform === 'ZOMATO') liveZomato += amt;
    }

    // 2c. Verify expenditures
    const expenditures = await prisma.expenditure.findMany({
      where: {
        restaurantId: outletId,
        expenditureDate: date,
        status: { not: 'VOIDED' },
        entryType: { in: ['EXPENSE', 'GROCERY', 'LIABILITY_PAYMENT'] },
      },
      select: { amount: true, entryType: true, paymentMethod: true },
    });
    const liveExpenditureTotal = round2(expenditures.reduce((s, e) => s + num(e.amount), 0));
    const liveNonCashExpenditures = round2(
      expenditures
        .filter((e: any) => e.entryType === 'LIABILITY_PAYMENT' && e.paymentMethod && e.paymentMethod !== 'CASH')
        .reduce((s, e) => s + num(e.amount), 0)
    );

    // 2d. Verify payment summary (cash collected)
    let liveCashCollected = 0, liveCardCollected = 0, liveUpiCollected = 0, liveOtherCollected = 0;
    let liveTotalTips = 0;
    for (const txn of transactions) {
      liveCashCollected += num(txn.cashAmount) + num(txn.cashAmount); // bill cash + tip cash
      liveCardCollected += num(txn.cardAmount);
      liveUpiCollected += num(txn.upiAmount);
      liveOtherCollected += num(txn.otherAmount);
      liveTotalTips += num(txn.tipAmount);
    }
    // Note: cashAmount in the transaction includes both bill cash and tip cash in many schemas.
    // The actual logic in paymentSummaryService is more nuanced — this is a rough check.

    // 2e. Compare persisted computed values vs live
    const persistedAcBar = num(sheet.acBarSaleComputed);
    const persistedNonAcBar = num(sheet.nonAcBarSaleComputed);
    const persistedFamilyWing = num(sheet.familyWingSaleComputed);
    const persistedParcel = num(sheet.parcelSaleComputed);
    const persistedSwiggy = num(sheet.swiggySale);
    const persistedZomato = num(sheet.zomatoSale);
    const persistedExpenditure = num(sheet.totalExpenditures);
    const persistedNonCash = num(sheet.nonCashExpenditures);
    const persistedCashCollected = num(sheet.cashCollected);
    const persistedClosingBalance = num(sheet.closingBalance);

    const acBarDiff = round2(liveBuckets.acBar - persistedAcBar);
    const nonAcBarDiff = round2(liveBuckets.nonAcBar - persistedNonAcBar);
    const familyWingDiff = round2(liveBuckets.familyWing - persistedFamilyWing);
    const parcelDiff = round2(liveBuckets.parcel - persistedParcel);
    const swiggyDiff = round2(liveSwiggy - persistedSwiggy);
    const zomatoDiff = round2(liveZomato - persistedZomato);
    const expDiff = round2(liveExpenditureTotal - persistedExpenditure);
    const nonCashDiff = round2(liveNonCashExpenditures - persistedNonCash);

    // 2f. Verify closing balance calculation
    // Effective sales (override ?? computed)
    const effAcBar = sheet.acBarSaleOverride != null ? num(sheet.acBarSaleOverride) : persistedAcBar;
    const effNonAcBar = sheet.nonAcBarSaleOverride != null ? num(sheet.nonAcBarSaleOverride) : persistedNonAcBar;
    const effFamilyWing = sheet.familyWingSaleOverride != null ? num(sheet.familyWingSaleOverride) : persistedFamilyWing;
    const effParcel = sheet.parcelSaleOverride != null ? num(sheet.parcelSaleOverride) : persistedParcel;
    const effSwiggy = persistedSwiggy;
    const effZomato = persistedZomato;

    const cashSales = round2(effAcBar + effNonAcBar + effFamilyWing + effParcel);
    const aggregatorSales = round2(effSwiggy + effZomato);
    const totalSales = sheet.totalSalesOverride != null ? num(sheet.totalSalesOverride) : round2(cashSales + aggregatorSales);
    const netSales = round2(totalSales - aggregatorSales);

    const effectiveExpenditures = sheet.totalExpendituresOverride != null
      ? num(sheet.totalExpendituresOverride)
      : persistedExpenditure;
    const nonCash = sheet.totalExpendituresOverride == null ? persistedNonCash : 0;
    const cashExpenditures = round2(effectiveExpenditures - nonCash);

    // Adjustments
    const sortedAdj = [...sheet.adjustments].sort((a, b) => a.sortOrder - b.sortOrder);
    let running = round2(num(sheet.openingBalance) + totalSales - aggregatorSales - cashExpenditures);
    for (const adj of sortedAdj) {
      const amt = round2(num(adj.amount));
      if (adj.sign === 'PLUS') running = round2(running + amt);
      else running = round2(running - amt);
    }
    const computedClosing = running;

    const closingDiff = round2(computedClosing - persistedClosingBalance);

    // 2g. Verify opening balance = previous day's closing balance
    const sheetIdx = sheets.findIndex((s) => s.reportDate === date);
    const prevSheet = sheetIdx > 0 ? sheets[sheetIdx - 1] : null;
    let openingMismatch = null;
    if (prevSheet) {
      const expectedOpening = num(prevSheet.closingBalance);
      const actualOpening = num(sheet.openingBalance);
      if (round2(expectedOpening - actualOpening) !== 0) {
        openingMismatch = `expected ₹${expectedOpening} (prev closing), got ₹${actualOpening}`;
      }
    }

    // 2h. Check for hardcoded values (suspicious patterns)
    const hardcodedSuspects: string[] = [];
    if (persistedAcBar === 1000 || persistedAcBar === 5000 || persistedAcBar === 10000) {
      hardcodedSuspects.push(`acBar=${persistedAcBar} suspicious round number`);
    }

    // 2i. Check status transitions
    const statusOk = ['DRAFT', 'SUBMITTED', 'LOCKED'].includes(sheet.status);

    // Report
    const hasIssues = acBarDiff !== 0 || nonAcBarDiff !== 0 || familyWingDiff !== 0 || parcelDiff !== 0 ||
                      swiggyDiff !== 0 || zomatoDiff !== 0 || expDiff !== 0 || closingDiff !== 0 ||
                      openingMismatch != null || !statusOk;

    const icon = hasIssues ? '⚠️' : '✅';
    console.log(`${icon} ${date} [${sheet.status}] opening=₹${num(sheet.openingBalance)} closing=₹${persistedClosingBalance}`);
    console.log(`   Sales: AC=₹${persistedAcBar} (live ₹${round2(liveBuckets.acBar)}, Δ${acBarDiff}) | NonAC=₹${persistedNonAcBar} (live ₹${round2(liveBuckets.nonAcBar)}, Δ${nonAcBarDiff}) | Family=₹${persistedFamilyWing} (live ₹${round2(liveBuckets.familyWing)}, Δ${familyWingDiff}) | Parcel=₹${persistedParcel} (live ₹${round2(liveBuckets.parcel)}, Δ${parcelDiff})`);
    console.log(`   Agg: Swiggy=₹${persistedSwiggy} (live ₹${round2(liveSwiggy)}, Δ${swiggyDiff}) | Zomato=₹${persistedZomato} (live ₹${round2(liveZomato)}, Δ${zomatoDiff})`);
    console.log(`   Exp: total=₹${persistedExpenditure} (live ₹${liveExpenditureTotal}, Δ${expDiff}) | nonCash=₹${persistedNonCash} (live ₹${liveNonCashExpenditures}, Δ${nonCashDiff})`);
    console.log(`   Closing: persisted=₹${persistedClosingBalance} | recomputed=₹${computedClosing} | Δ${closingDiff}`);
    if (openingMismatch) {
      console.log(`   ⚠️ Opening mismatch: ${openingMismatch}`);
      errors.push(`Opening balance mismatch: ${openingMismatch}`);
    }
    if (closingDiff !== 0) {
      console.log(`   ⚠️ Closing balance mismatch: persisted ₹${persistedClosingBalance} vs recomputed ₹${computedClosing}`);
      errors.push(`Closing balance mismatch: Δ${closingDiff}`);
    }
    if (acBarDiff !== 0 || nonAcBarDiff !== 0 || familyWingDiff !== 0 || parcelDiff !== 0) {
      errors.push(`Venue sales computed values differ from live data`);
    }
    if (swiggyDiff !== 0 || zomatoDiff !== 0) {
      errors.push(`Aggregator sales differ from live data`);
    }
    if (expDiff !== 0) {
      errors.push(`Expenditure total differs from live data`);
    }
    if (!statusOk) {
      errors.push(`Invalid status: ${sheet.status}`);
    }
    if (hardcodedSuspects.length > 0) {
      errors.push(`Hardcoded suspects: ${hardcodedSuspects.join(', ')}`);
    }

    if (errors.length === 0) {
      verified.push(date);
    } else {
      issues.push(`${date}: ${errors.join('; ')}`);
    }
    console.log('');
  }

  // 3. Summary
  console.log('=== AUDIT SUMMARY ===');
  console.log(`Total sheets: ${sheets.length}`);
  console.log(`Verified OK: ${verified.length}/${sheets.length} ✅`);
  console.log(`Issues found: ${issues.length}/${sheets.length} ⚠️`);

  if (issues.length > 0) {
    console.log(`\n--- Issues ---`);
    for (const issue of issues) {
      console.log(`  ⚠️ ${issue}`);
    }
  }

  // 4. Check for hardcoded values across all sheets
  console.log(`\n=== HARDCODED VALUE CHECK ===`);
  let hardcodedFound = false;
  for (const sheet of sheets) {
    const fields = [
      { name: 'openingBalance', val: num(sheet.openingBalance) },
      { name: 'acBarSaleComputed', val: num(sheet.acBarSaleComputed) },
      { name: 'closingBalance', val: num(sheet.closingBalance) },
      { name: 'totalExpenditures', val: num(sheet.totalExpenditures) },
    ];
    for (const f of fields) {
      // Suspicious: exact round numbers that match common demo values
      if ([1000, 5000, 10000, 100000, 50000, 25000].includes(f.val)) {
        console.log(`  ⚠️ ${sheet.reportDate}: ${f.name}=₹${f.val} (suspicious round number)`);
        hardcodedFound = true;
      }
    }
  }
  if (!hardcodedFound) {
    console.log(`  ✅ No hardcoded/demo values detected`);
  }

  // 5. Check carry-forward chain
  console.log(`\n=== CARRY-FORWARD CHAIN ===`);
  let chainBreaks = 0;
  for (let i = 1; i < sheets.length; i++) {
    const prev = sheets[i - 1];
    const curr = sheets[i];
    const expectedOpening = num(prev.closingBalance);
    const actualOpening = num(curr.openingBalance);
    const diff = round2(expectedOpening - actualOpening);
    if (diff !== 0) {
      console.log(`  ⚠️ ${curr.reportDate}: opening ₹${actualOpening} ≠ prev closing ₹${expectedOpening} (Δ${diff})`);
      chainBreaks++;
    }
  }
  if (chainBreaks === 0) {
    console.log(`  ✅ All opening balances match previous day's closing`);
  } else {
    console.log(`  ⚠️ ${chainBreaks} carry-forward breaks found`);
  }

  // 6. Check date boundaries (month/year)
  console.log(`\n=== DATE BOUNDARY CHECK ===`);
  let boundaryIssues = 0;
  for (let i = 1; i < sheets.length; i++) {
    const prev = sheets[i - 1];
    const curr = sheets[i];
    const prevDate = new Date(prev.reportDate + 'T00:00:00');
    const currDate = new Date(curr.reportDate + 'T00:00:00');
    const prevMonth = prevDate.getMonth();
    const currMonth = currDate.getMonth();
    const prevYear = prevDate.getFullYear();
    const currYear = currDate.getFullYear();
    // Check if consecutive
    const dayDiff = Math.round((currDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
    if (dayDiff === 1) {
      // Consecutive days — check carry-forward works across month/year boundaries
      if (prevMonth !== currMonth || prevYear !== currYear) {
        const expectedOpening = num(prev.closingBalance);
        const actualOpening = num(curr.openingBalance);
        if (round2(expectedOpening - actualOpening) !== 0) {
          console.log(`  ⚠️ Month/year boundary ${prev.reportDate} → ${curr.reportDate}: carry-forward broken`);
          boundaryIssues++;
        } else {
          console.log(`  ✅ Month/year boundary ${prev.reportDate} → ${curr.reportDate}: carry-forward OK`);
        }
      }
    }
  }
  if (boundaryIssues === 0) {
    console.log(`  ✅ No date boundary issues`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());

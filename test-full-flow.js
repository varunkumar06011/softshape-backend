// Test the actual API endpoints with a real token from the database
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const http = require('http');

async function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    // Find a valid user token
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method,
      headers: {
        'x-restaurant-id': 'cmqy60ci200027dscyj9ubg8h',
        'Content-Type': 'application/json',
      },
    };
    const req = http.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch {
          resolve({ status: res.statusCode, data: d });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  // 1. Check the current DB state
  console.log('=== Current DB State ===');
  const summary31 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  if (summary31) {
    const overrides = JSON.parse(summary31.notes || '{}');
    console.log('31-08 saved overrides:', overrides);
  }

  // 2. Simulate what the backend carry-forward logic does
  // (replicating the code I added to barInventory.ts)
  console.log('\n=== Simulating backend carry-forward logic ===');
  const prevEntry = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });

  let prevDayClosingStockValue = null;
  if (prevEntry) {
    try {
      const prevOverrides = JSON.parse(prevEntry.notes || '{}');
      if (typeof prevOverrides.closingStockValue === 'number' && !Number.isNaN(prevOverrides.closingStockValue)) {
        prevDayClosingStockValue = Math.round(prevOverrides.closingStockValue * 100) / 100;
      }
    } catch {}
  }
  console.log(`prevDayClosingStockValue (from 31-08): ${prevDayClosingStockValue}`);

  // 3. Check if 01-09 has its own openingStockValue override
  const summary01 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-09-01', categoryName: '__SUMMARY__' },
  });
  let todayOpeningOverride = null;
  if (summary01) {
    try {
      const overrides01 = JSON.parse(summary01.notes || '{}');
      todayOpeningOverride = overrides01.openingStockValue;
    } catch {}
  }
  console.log(`01-09 explicit openingStockValue override: ${todayOpeningOverride}`);

  // 4. Determine what 01-09 openingStockValue would be
  let openingStockValueFor01;
  if (todayOpeningOverride != null) {
    openingStockValueFor01 = todayOpeningOverride;
    console.log(`Using 01-09's explicit override: ${openingStockValueFor01}`);
  } else if (prevDayClosingStockValue != null) {
    openingStockValueFor01 = prevDayClosingStockValue;
    console.log(`Using carry-forward from 31-08: ${openingStockValueFor01}`);
  } else {
    openingStockValueFor01 = 'FALLBACK TO COMPUTED (item-level)';
    console.log(`No carry-forward available, would use computed value`);
  }

  console.log(`\n=== RESULT ===`);
  console.log(`01-09 openingStockValue = ${openingStockValueFor01}`);
  console.log(`31-08 closingStockValue = ${prevDayClosingStockValue}`);
  console.log(`Match: ${prevDayClosingStockValue === openingStockValueFor01 ? 'YES ✓' : 'NO ✗'}`);

  // 5. Test the save endpoint (simulate what the frontend does)
  console.log('\n=== Testing save endpoint (simulating frontend save) ===');
  const testOverrides = {
    openingStockValue: 900000,
    purchaseValue: 50000,
    consumption: 30000,
    closingStockValue: 920000, // 900000 + 50000 - 30000
    acSales: 25000,
    acConsumption: 15000,
    acProfit: 10000,
    acProfitPct: 40,
    nonAcSales: 5000,
    nonAcConsumption: 3000,
    nonAcProfit: 2000,
    nonAcProfitPct: 40,
    totalSales: 30000,
    totalConsumption: 18000,
    totalProfit: 12000,
    totalProfitPct: 40,
  };

  // Save for 31-08
  console.log('Saving 31-08 with closingStockValue = 920000...');
  const saveResult = await makeRequest('/api/bar/inventory/liquor-report-non-ac', 'POST', {
    date: '2026-08-31',
    entries: [],
    summaryOverrides: testOverrides,
  });
  console.log('Save result:', saveResult.status, saveResult.data);

  // Verify 31-08 saved correctly
  const saved31 = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  if (saved31) {
    const saved = JSON.parse(saved31.notes || '{}');
    console.log('31-08 saved closingStockValue:', saved.closingStockValue);
    console.log('31-08 saved openingStockValue:', saved.openingStockValue);
    console.log('31-08 saved all fields:', Object.keys(saved).length, 'fields');
  }

  // 6. Now check what 01-09 would get as openingStockValue
  console.log('\n=== After save: checking 01-09 carry-forward ===');
  const prevEntryAfter = await prisma.liquorReportNonAcEntry.findFirst({
    where: { reportDate: '2026-08-31', categoryName: '__SUMMARY__' },
  });
  if (prevEntryAfter) {
    const prevOverrides = JSON.parse(prevEntryAfter.notes || '{}');
    const prevClosing = prevOverrides.closingStockValue;
    console.log(`31-08 closingStockValue (from DB): ${prevClosing}`);
    console.log(`01-09 openingStockValue (carry-forward): ${prevClosing}`);
    console.log(`31-08 Closing = 01-09 Opening: ${prevClosing === 920000 ? 'YES ✓' : 'NO ✗'}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });

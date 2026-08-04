#!/usr/bin/env node
/**
 * check-unscoped-prisma.js — Lint check for basePrisma/unscopedPrisma imports
 *
 * Fails CI if any file outside the allowlist imports `basePrisma` or `unscopedPrisma`
 * from lib/prisma. These exports bypass tenant scoping and must only be used in
 * explicitly approved system-level files.
 *
 * Usage: node scripts/check-unscoped-prisma.js
 * Exit code: 0 = pass, 1 = violations found
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');

// Files allowed to import basePrisma/unscopedPrisma
const ALLOWLIST = new Set([
  // Core infrastructure
  'lib/prisma.ts',
  'lib/tenantContext.ts',
  'lib/auditLog.ts',
  'index.ts',
  'config/pricing.ts',
  'utils/captainMap.ts',
  // Middleware (needs unscoped for context resolution)
  'middleware/tenantScope.ts',
  // Auth (login/registration needs cross-tenant lookups)
  'routes/auth.ts',
  // System-level routes
  'routes/superadmin.ts',
  'routes/public.ts',
  'routes/seed.ts',
  'routes/edge.ts',
  'routes/auditLog.ts',
  'routes/representativeQr.ts',
  // Multi-outlet aggregation routes (need explicit tenant scope)
  'routes/reports.ts',
  'routes/restaurant.ts',
  'routes/onboard.ts',
  'routes/xReport.ts',
  'routes/dailyBalanceSheet.ts',
  'routes/cogs.ts',
  'routes/expenditures.ts',
  'routes/fixedAssets.ts',
  'routes/purchaseOrders.ts',
  'routes/transactions.ts',
  'routes/venues.ts',
  'routes/tables.ts',
  'routes/barInventory.ts',
  'routes/kitchenInventory.ts',
  // Services with multi-outlet aggregation
  'services/dailyBalanceSheetService.ts',
  'services/xReportService.ts',
  'services/transactionDeleteService.ts',
  'services/orderService.ts',
  'services/recipeEngine.ts',
]);

const PATTERNS = [
  /\bbasePrisma\b/,
  /\bunscopedPrisma\b/,
];

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results;
}

const files = walkDir(SRC_DIR);
const violations = [];

for (const file of files) {
  const relPath = path.relative(SRC_DIR, file).replace(/\\/g, '/');
  if (ALLOWLIST.has(relPath)) continue;

  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of PATTERNS) {
    if (pattern.test(content)) {
      // Check if it's an actual import or just a comment mentioning it
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pattern.test(line) && (line.includes('import') || line.includes('require'))) {
          violations.push({ file: relPath, line: i + 1, content: line.trim() });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('\n[TenantScope] Violations: basePrisma/unscopedPrisma imported outside allowlist\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.content}\n`);
  }
  console.error(`Total: ${violations.length} violation(s)`);
  console.error('\nAllowlist:');
  for (const f of ALLOWLIST) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log('[TenantScope] No unscoped Prisma imports outside allowlist — OK');
  process.exit(0);
}

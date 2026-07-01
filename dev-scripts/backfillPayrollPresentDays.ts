// Backfill PayrollRecord.presentDays from the legacy absentDays field.
//
// Old formula: netPayable = baseSalary - (baseSalary/30 * absentDays) + ...
// New formula: actualSalary = (presentDays + leaveDays + otDays*0.5) * (baseSalary/30)
//
// Backfill rule:
//   - presentDays = MAX(30 - absentDays, 0)
//   - For records that look voucher-only (absentDays=0, otDays=0, paidAmount=0, advanceAmount>0),
//     cap presentDays at 26 so the 4-day leave slab keeps initial actualSalary <= baseSalary.
//
// Usage (from softshape-backend directory):
//   npx ts-node dev-scripts/backfillPayrollPresentDays.ts        -- dry run
//   npx ts-node dev-scripts/backfillPayrollPresentDays.ts --apply -- apply changes

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const records = await prisma.payrollRecord.findMany({
    select: {
      id: true,
      employeeId: true,
      monthYear: true,
      absentDays: true,
      otDays: true,
      paidAmount: true,
      advanceAmount: true,
    },
  });

  const updates: { id: string; presentDays: number; reason: string }[] = [];

  for (const rec of records) {
    const absent = rec.absentDays || 0;
    const paid = Number(rec.paidAmount || 0);
    const advance = Number(rec.advanceAmount || 0);
    const ot = rec.otDays || 0;

    const looksVoucherOnly = absent === 0 && ot === 0 && paid === 0 && advance > 0;
    let presentDays = Math.max(30 - absent, 0);
    let reason = `30 - absentDays(${absent})`;

    if (looksVoucherOnly) {
      presentDays = Math.min(presentDays, 26);
      reason = `voucher-only record capped: 30 - absentDays(${absent}) -> 26`;
    }

    updates.push({ id: rec.id, presentDays, reason });
  }

  console.log(`Found ${records.length} payroll records.`);
  console.log(`Dry run: ${!APPLY}. Changes would be applied: ${APPLY}.`);
  console.log();

  const voucherOnly = updates.filter((u) => u.reason.startsWith('voucher-only'));
  console.log(`Voucher-only records detected: ${voucherOnly.length}`);
  if (voucherOnly.length > 0) {
    console.log('Sample IDs:', voucherOnly.slice(0, 10).map((u) => u.id).join(', '));
  }
  console.log();

  console.log('Preview of changes (first 20):');
  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u.id} -> presentDays=${u.presentDays} (${u.reason})`);
  }
  if (updates.length > 20) {
    console.log(`  ... and ${updates.length - 20} more`);
  }

  if (!APPLY) {
    console.log();
    console.log('This was a dry run. To apply, run with --apply.');
    return;
  }

  console.log();
  console.log('Applying updates...');
  for (const u of updates) {
    await prisma.payrollRecord.update({
      where: { id: u.id },
      data: { presentDays: u.presentDays },
    });
  }
  console.log(`Updated ${updates.length} records.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

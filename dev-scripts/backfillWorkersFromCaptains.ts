// ─────────────────────────────────────────────────────────────────────────────
// backfillWorkersFromCaptains.ts
// ─────────────────────────────────────────────────────────────────────────────
// One-time backfill: demote users who currently have role = 'CAPTAIN' but whose
// employee.designation is NOT a real captain designation, to the new 'WORKER'
// role. This cleans up the historical conflation where every floor-staff member
// was created as CAPTAIN regardless of their actual job title.
//
// After running this, the admin should review the list of remaining CAPTAIN
// users and manually promote any real captains that were incorrectly demoted
// (rare, since the designation list has no "captain" entry — most CAPTAIN users
// will be demoted and the admin re-promotes the true captains).
//
// Usage:
//   npx tsx dev-scripts/backfillWorkersFromCaptains.ts            # dry-run (prints only)
//   npx tsx dev-scripts/backfillWorkersFromCaptains.ts --apply     # execute changes
// ─────────────────────────────────────────────────────────────────────────────

import prisma from '../src/lib/prisma';

// Designations that should keep the CAPTAIN role (i.e. real captains).
// The current DESIGNATIONS list in the frontend has NO "captain" entry, so this
// set is empty by default — meaning every CAPTAIN user with a non-captain
// designation gets demoted. If you later add a 'captain' designation value,
// add it here so those users are preserved.
const CAPTAIN_DESIGNATIONS: string[] = [
  // 'captain',
];

// Normalize for comparison: lowercase, trimmed.
const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const captainSet = new Set(CAPTAIN_DESIGNATIONS.map(norm));

async function backfillWorkersFromCaptains() {
  const apply = process.argv.includes('--apply');
  console.log(`[backfillWorkersFromCaptains] mode: ${apply ? 'APPLY' : 'DRY-RUN (use --apply to execute)'}`);

  // Find all active users currently marked as CAPTAIN, with their linked employee.
  const captains = await prisma.user.findMany({
    where: { role: 'CAPTAIN', isActive: true },
    include: { employee: { select: { id: true, designation: true } } },
  });

  console.log(`[backfillWorkersFromCaptains] Found ${captains.length} active CAPTAIN users.`);

  const toDemote: typeof captains = [];
  const toKeep: typeof captains = [];

  for (const u of captains) {
    const designation = norm(u.employee?.designation);
    // A user keeps CAPTAIN only if their designation is explicitly in the captain set.
    // If the set is empty (default), everyone is demoted — admin re-promotes true captains.
    if (designation && captainSet.has(designation)) {
      toKeep.push(u);
    } else {
      toDemote.push(u);
    }
  }

  console.log(`\n[backfillWorkersFromCaptains] KEEP as CAPTAIN (${toKeep.length}):`);
  for (const u of toKeep) {
    console.log(`  - ${u.name} | id=${u.id} | designation="${u.employee?.designation ?? ''}"`);
  }

  console.log(`\n[backfillWorkersFromCaptains] DEMOTE to WORKER (${toDemote.length}):`);
  for (const u of toDemote) {
    console.log(`  - ${u.name} | id=${u.id} | designation="${u.employee?.designation ?? ''}"`);
  }

  if (!apply) {
    console.log(`\n[backfillWorkersFromCaptains] DRY-RUN complete. No changes made.`);
    console.log(`[backfillWorkersFromCaptains] Re-run with --apply to execute.`);
    return;
  }

  let demoted = 0;
  for (const u of toDemote) {
    // Demote to WORKER and clear PIN (workers have no app access, no PIN needed).
    await prisma.user.update({
      where: { id: u.id },
      data: { role: 'WORKER', pin: null },
    });
    demoted++;
  }

  console.log(`\n[backfillWorkersFromCaptains] APPLY complete. Demoted ${demoted} users to WORKER.`);
  console.log(`[backfillWorkersFromCaptains] Review the remaining ${toKeep.length} CAPTAIN users in the admin panel.`);
}

backfillWorkersFromCaptains()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

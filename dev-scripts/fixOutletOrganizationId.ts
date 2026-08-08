// Repair script for outlets whose organizationId doesn't match the org their
// users actually belong to.
//
// Background: Today Specials "All Outlets" sync and analytics aggregation
// resolve sibling outlets from the creator's outlet organizationId (or the
// JWT organizationId). When an outlet's organizationId points to a different
// org than the rest of the outlets its users access, specials created from
// that outlet never fan out, and analytics counts stay scoped to that one
// outlet — even though the user (e.g. a manager) has OutletAccess to outlets
// in the correct org.
//
// Detection heuristic:
//   1. Find users with OutletAccess to outlets in more than one organization
//      (cross-org users — typically managers/admins who should be in one org).
//   2. For each such user, the "majority org" is the org with the most
//      accessible outlets; outlets in the minority org(s) are suspects.
//   3. A suspect outlet is confirmed broken if it's the ONLY outlet in its
//      current org (a singleton org is almost always a mis-assignment).
//
// Usage (from softshape-backend directory):
//   npx ts-node --compiler-options "{\"module\":\"CommonJS\"}" dev-scripts/fixOutletOrganizationId.ts          -- dry run (report only)
//   npx ts-node --compiler-options "{\"module\":\"CommonJS\"}" dev-scripts/fixOutletOrganizationId.ts --apply  -- reassign broken outlets

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

interface OutletRow {
  id: string;
  name: string;
  restaurantCode: string;
  organizationId: string;
}

async function main() {
  // 1. Load every active outlet with its org.
  const outlets = await prisma.outlet.findMany({
    where: { isActive: true },
    select: { id: true, name: true, restaurantCode: true, organizationId: true },
  });
  const outletById = new Map<string, OutletRow>(outlets.map(o => [o.id, o]));

  // 2. Group outlets by organization.
  const orgOutlets = new Map<string, OutletRow[]>();
  for (const o of outlets) {
    const list = orgOutlets.get(o.organizationId) ?? [];
    list.push(o);
    orgOutlets.set(o.organizationId, list);
  }

  // 3. Load all OutletAccess rows with the outlet's org.
  const access = await prisma.outletAccess.findMany({
    select: { userId: true, outletId: true },
  });

  // 4. For each user, collect the set of orgs they can access.
  const userOrgs = new Map<string, Map<string, string[]>>(); // userId -> orgId -> outletIds
  for (const a of access) {
    const outlet = outletById.get(a.outletId);
    if (!outlet) continue; // access to inactive/unknown outlet — skip
    const orgMap = userOrgs.get(a.userId) ?? new Map<string, string[]>();
    const list = orgMap.get(outlet.organizationId) ?? [];
    list.push(outlet.id);
    orgMap.set(outlet.organizationId, list);
    userOrgs.set(a.userId, orgMap);
  }

  // 5. Find cross-org users and their suspect outlets.
  //    A suspect outlet is one in a singleton org that the user accesses
  //    alongside outlets in a larger org.
  const reassignments = new Map<string, string>(); // outletId -> correctOrgId
  const reasons = new Map<string, string>();       // outletId -> human reason

  for (const [userId, orgMap] of userOrgs) {
    if (orgMap.size < 2) continue; // user only accesses one org — no mismatch
    // Pick the majority org: the one with the most accessible outlets.
    let majorityOrgId = '';
    let majorityCount = 0;
    for (const [orgId, outletIds] of orgMap) {
      if (outletIds.length > majorityCount) {
        majorityCount = outletIds.length;
        majorityOrgId = orgId;
      }
    }
    if (!majorityOrgId) continue;
    // Suspects: outlets in the minority org(s) that are ALSO singleton orgs.
    for (const [orgId, outletIds] of orgMap) {
      if (orgId === majorityOrgId) continue;
      const orgTotalOutlets = orgOutlets.get(orgId)?.length ?? 0;
      // Only flag if the minority org is a singleton — reassigning an outlet
      // out of a multi-outlet org is riskier and needs manual review.
      if (orgTotalOutlets !== 1) continue;
      for (const outletId of outletIds) {
        if (reassignments.has(outletId)) {
          // Already flagged — keep the first reason. If two users disagree on
          // the majority org, we skip reassignment for safety.
          const existing = reassignments.get(outletId);
          if (existing && existing !== majorityOrgId) {
            console.warn(`[CONFLICT] Outlet ${outletId} flagged for two different target orgs: ${existing} vs ${majorityOrgId}. Skipping — needs manual review.`);
            reassignments.delete(outletId);
            reasons.set(outletId, `CONFLICT: flagged for orgs ${existing} and ${majorityOrgId} by different users — manual review required`);
          }
          continue;
        }
        reassignments.set(outletId, majorityOrgId);
        const outlet = outletById.get(outletId);
        reasons.set(outletId, `Outlet "${outlet?.name}" (${outlet?.restaurantCode}) is in singleton org ${orgId} but user ${userId} also accesses ${majorityCount} outlet(s) in org ${majorityOrgId}.`);
      }
    }
  }

  if (reassignments.size === 0) {
    console.log('No broken outlet organizationId assignments found.');
    console.log(`Scanned ${outlets.length} outlets across ${orgOutlets.size} organizations, ${userOrgs.size} users with OutletAccess.`);
    return;
  }

  console.log(`Found ${reassignments.size} outlet(s) with mis-assigned organizationId:\n`);
  for (const [outletId, targetOrgId] of reassignments) {
    const outlet = outletById.get(outletId);
    console.log(`  Outlet: ${outlet?.name} (${outlet?.restaurantCode})`);
    console.log(`    id:                  ${outletId}`);
    console.log(`    current organizationId: ${outlet?.organizationId}`);
    console.log(`    target organizationId: ${targetOrgId}`);
    console.log(`    reason: ${reasons.get(outletId)}`);
    console.log();
  }

  if (!APPLY) {
    console.log('Dry run — no changes made. Add --apply to reassign these outlets.');
    return;
  }

  // Apply: update each broken outlet's organizationId to the correct org.
  let updated = 0;
  for (const [outletId, targetOrgId] of reassignments) {
    try {
      await prisma.outlet.update({
        where: { id: outletId },
        data: { organizationId: targetOrgId },
      });
      console.log(`[OK] Reassigned ${outletId} -> org ${targetOrgId}`);
      updated++;
    } catch (err) {
      console.error(`[FAIL] Could not reassign ${outletId}:`, err);
    }
  }
  console.log(`\nReassigned ${updated}/${reassignments.size} outlets.`);

  // Clear tenant context cache so resolveTenantContext picks up the new org.
  // The cache is keyed by tenantctx:{restaurantId}:v{version}; a version bump
  // isn't automatic, so recommend flushing the cache or restarting the backend.
  console.log('\nNOTE: restart the backend (or flush the tenant-context cache) so resolveTenantContext reads the updated organizationId.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

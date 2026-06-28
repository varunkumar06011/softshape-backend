// ─────────────────────────────────────────────────────────────────────────────
// SuperAdmin Routes — Platform-wide administration (cross-tenant)
// ─────────────────────────────────────────────────────────────────────────────
// Provides superadmin endpoints for managing all restaurants, organizations,
// billing status, and trial periods. These routes bypass tenant scoping and
// access data across all tenants.
//
// Authentication: Uses a separate SUPERADMIN_SECRET header (x-superadmin-secret)
// instead of JWT auth. This keeps superadmin access completely separate from
// regular staff authentication.
//
// Endpoints:
//   GET   /api/superadmin/restaurants              — list all restaurants grouped by org
//   GET   /api/superadmin/stats                    — platform-wide statistics
//   PATCH /api/superadmin/restaurants/:id/suspend  — suspend an organization
//   PATCH /api/superadmin/restaurants/:id/activate — activate an organization
//   PATCH /api/superadmin/restaurants/:id/extend-trial — extend trial period
//
// All mutations create audit log entries for accountability.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import logger from "../lib/logger";
import prisma from '../lib/prisma';
import { createAuditLog } from '../lib/auditLog';

const router = Router();

// SuperAdmin secret from env — if not set, all superadmin requests are rejected
const SUPERADMIN_SECRET = process.env.SUPERADMIN_SECRET;
if (!SUPERADMIN_SECRET) {
  logger.warn("[SuperAdmin] SUPERADMIN_SECRET env var is not set — all superadmin requests will be rejected");
}

// Middleware that validates the x-superadmin-secret header against the configured secret.
// Returns 401 if the secret is missing or doesn't match.
function requireSuperAdmin(req: Request, res: Response, next: any) {
  const secret = req.headers['x-superadmin-secret'];
  if (!SUPERADMIN_SECRET || secret !== SUPERADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/superadmin/restaurants
router.get('/restaurants', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const outlets = await prisma.outlet.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            billingStatus: true,
            trialEndsAt: true,
            plan: true,
          }
        }
      },
      select: {
        id: true,
        name: true,
        slug: true,
        restaurantCode: true,
        restaurantType: true,
        isActive: true,
        createdAt: true,
        onboardingCompletedAt: true,
        organization: true,
        _count: { select: { users: true } }
      }
    });

    // Flatten organization billing fields into each outlet for backward compatibility
    const restaurants = outlets.map(o => ({
      ...o,
      billingStatus: o.organization?.billingStatus,
      trialEndsAt: o.organization?.trialEndsAt,
      plan: o.organization?.plan,
      organizationId: o.organization?.id,
      organizationName: o.organization?.name,
    }));

    // Group by organization
    const grouped: Record<string, {
      organizationId: string;
      organizationName: string;
      plan: string;
      billingStatus: string;
      trialEndsAt: string | Date | null;
      outlets: typeof restaurants;
    }> = {};

    for (const r of restaurants) {
      const orgId = r.organizationId ?? 'unknown';
      if (!grouped[orgId]) {
        grouped[orgId] = {
          organizationId: orgId,
          organizationName: r.organizationName ?? 'Unknown',
          plan: r.plan ?? 'starter',
          billingStatus: r.billingStatus ?? 'unknown',
          trialEndsAt: r.trialEndsAt ?? null,
          outlets: [],
        };
      }
      grouped[orgId].outlets.push(r);
    }

    return res.json({ restaurants, grouped: Object.values(grouped) });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/superadmin/stats
router.get('/stats', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const total = await prisma.outlet.count();
    const active = await prisma.outlet.count({ where: { isActive: true } });
    const trialing = await prisma.organization.count({ where: { billingStatus: 'trialing' } });
    const suspended = await prisma.organization.count({ where: { billingStatus: 'suspended' } });
    const expired = await prisma.organization.count({ where: { billingStatus: 'expired' } });
    const totalUsers = await prisma.user.count();
    return res.json({ total, active, trialing, suspended, expired, totalUsers });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Stats] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/restaurants/:id/suspend
router.patch('/restaurants/:id/suspend', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const outlet = await prisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });
    await prisma.organization.update({
      where: { id: outlet.organizationId },
      data: { billingStatus: 'suspended' }
    });
    createAuditLog({
      action: 'SUPERADMIN_SUSPEND',
      entityType: 'Organization',
      entityId: outlet.organizationId,
      metadata: { outletId: id },
    });
    return res.json({ message: 'Restaurant suspended' });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Suspend] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/restaurants/:id/activate
router.patch('/restaurants/:id/activate', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const outlet = await prisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });
    await prisma.organization.update({
      where: { id: outlet.organizationId },
      data: { billingStatus: 'active' }
    });
    createAuditLog({
      action: 'SUPERADMIN_ACTIVATE',
      entityType: 'Organization',
      entityId: outlet.organizationId,
      metadata: { outletId: id },
    });
    return res.json({ message: 'Restaurant activated' });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Activate] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/restaurants/:id/extend-trial
router.patch('/restaurants/:id/extend-trial', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { days } = req.body;
    const extendDays = Number(days) || 14;
    const outlet = await prisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });

    const org = await prisma.organization.findUnique({ where: { id: outlet.organizationId }, select: { trialEndsAt: true } });
    const currentTrialEnd = org?.trialEndsAt || new Date();
    const newTrialEnd = new Date(currentTrialEnd.getTime() + extendDays * 24 * 60 * 60 * 1000);

    await prisma.organization.update({
      where: { id: outlet.organizationId },
      data: { trialEndsAt: newTrialEnd, billingStatus: 'trialing' }
    });
    createAuditLog({
      action: 'SUPERADMIN_EXTEND_TRIAL',
      entityType: 'Organization',
      entityId: outlet.organizationId,
      metadata: { outletId: id, extendDays, trialEndsAt: newTrialEnd.toISOString() },
    });
    return res.json({ message: `Trial extended by ${extendDays} days`, trialEndsAt: newTrialEnd });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Extend Trial] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as superadminRouter };

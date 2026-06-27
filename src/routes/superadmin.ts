import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { createAuditLog } from '../lib/auditLog';

const router = Router();

const SUPERADMIN_SECRET = process.env.SUPERADMIN_SECRET;
if (!SUPERADMIN_SECRET) {
  console.warn("[SuperAdmin] SUPERADMIN_SECRET env var is not set — all superadmin requests will be rejected");
}

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
        isActive: true,
        createdAt: true,
        onboardingCompletedAt: true,
        organization: true,
        _count: { select: { users: true } }
      }
    });
    // Flatten organization billing fields into response for backward compatibility
    const restaurants = outlets.map(o => ({
      ...o,
      billingStatus: o.organization?.billingStatus,
      trialEndsAt: o.organization?.trialEndsAt,
      plan: o.organization?.plan,
    }));
    return res.json(restaurants);
  } catch (error) {
    console.error('[SuperAdmin] Error:', error);
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
    console.error('[SuperAdmin Stats] Error:', error);
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
    console.error('[SuperAdmin Suspend] Error:', error);
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
    console.error('[SuperAdmin Activate] Error:', error);
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
    console.error('[SuperAdmin Extend Trial] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as superadminRouter };

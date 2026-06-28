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
import crypto from 'crypto';
import logger from "../lib/logger";
import { basePrisma } from '../lib/prisma';
import { createAuditLog } from '../lib/auditLog';
import { invalidatePlanConfigCache } from '../config/pricing';
import { cacheDelete } from '../lib/cache';
import { billingCacheKey } from '../middleware/subscriptionCheck';
import { getIo } from '../socket';

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
  if (!SUPERADMIN_SECRET || typeof secret !== 'string') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const a = Buffer.from(secret);
    const b = Buffer.from(SUPERADMIN_SECRET);
    // Pad both buffers to the same length to prevent length-based timing leaks.
    // Without this, an attacker can infer the secret length by measuring response time
    // (a.length !== b.length returns early before timingSafeEqual runs).
    const maxLen = Math.max(a.length, b.length);
    const aPadded = Buffer.alloc(maxLen);
    const bPadded = Buffer.alloc(maxLen);
    a.copy(aPadded);
    b.copy(bPadded);
    if (!crypto.timingSafeEqual(aPadded, bPadded)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/superadmin/restaurants?page=1&limit=50
router.get('/restaurants', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    const [outlets, total] = await Promise.all([
      basePrisma.outlet.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          slug: true,
          restaurantCode: true,
          restaurantType: true,
          isActive: true,
          createdAt: true,
          onboardingCompletedAt: true,
          organization: {
            select: {
              id: true,
              name: true,
              billingStatus: true,
              trialEndsAt: true,
              plan: true,
            }
          },
          _count: { select: { users: true } }
        }
      }),
      basePrisma.outlet.count(),
    ]);

    // Flatten organization billing fields into each outlet for backward compatibility
    // Also check print agent socket health — count sockets in each restaurant's print room
    let io: any = null;
    try { io = getIo(); } catch { /* socket.io not yet initialized */ }

    const restaurants = await Promise.all(outlets.map(async o => {
      let printAgentConnected = false;
      let printRoomSockets = 0;
      if (io) {
        const room = `print:${o.id}`;
        const sockets = await io.adapter.sockets(new Set([room]));
        printRoomSockets = sockets.size;
        printAgentConnected = printRoomSockets > 0;
      }
      return {
        ...o,
        billingStatus: o.organization?.billingStatus,
        trialEndsAt: o.organization?.trialEndsAt,
        plan: o.organization?.plan,
        organizationId: o.organization?.id,
        organizationName: o.organization?.name,
        printAgentConnected,
        printRoomSockets,
      };
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

    return res.json({ restaurants, grouped: Object.values(grouped), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/superadmin/stats
router.get('/stats', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const total = await basePrisma.outlet.count();
    const active = await basePrisma.outlet.count({ where: { isActive: true } });
    const trialing = await basePrisma.organization.count({ where: { billingStatus: 'trialing' } });
    const suspended = await basePrisma.organization.count({ where: { billingStatus: 'suspended' } });
    const expired = await basePrisma.organization.count({ where: { billingStatus: 'expired' } });
    const totalUsers = await basePrisma.user.count();
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
    const outlet = await basePrisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });
    await basePrisma.organization.update({
      where: { id: outlet.organizationId },
      data: { billingStatus: 'suspended' }
    });
    await cacheDelete(billingCacheKey(outlet.organizationId));
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
    const outlet = await basePrisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });
    await basePrisma.organization.update({
      where: { id: outlet.organizationId },
      data: { billingStatus: 'active' }
    });
    await cacheDelete(billingCacheKey(outlet.organizationId));
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
    const outlet = await basePrisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });

    const org = await basePrisma.organization.findUnique({ where: { id: outlet.organizationId }, select: { trialEndsAt: true } });
    const currentTrialEnd = org?.trialEndsAt || new Date();
    const newTrialEnd = new Date(currentTrialEnd.getTime() + extendDays * 24 * 60 * 60 * 1000);

    await basePrisma.organization.update({
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

// ── Restaurant Detail ────────────────────────────────────────────────────────

// GET /api/superadmin/restaurants/:id — full detail for one outlet
router.get('/restaurants/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const outlet = await basePrisma.outlet.findUnique({
      where: { id },
      include: {
        organization: { select: { id: true, name: true, plan: true, billingStatus: true, trialEndsAt: true, paymentStatus: true, features: true, enabledModules: true } },
        users: { select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true } },
      },
    });
    if (!outlet) return res.status(404).json({ error: 'Outlet not found' });

    const menuItemCount = await basePrisma.menuItem.count({ where: { restaurantId: id, isDeleted: false } });
    const orderCount = await basePrisma.order.count({ where: { restaurantId: id } });
    const txnCount = await basePrisma.transaction.count({ where: { restaurantId: id } });
    const tableCount = await basePrisma.table.count({ where: { restaurantId: id } });
    const userCount = outlet.users.length;

    return res.json({
      ...outlet,
      billingStatus: outlet.organization?.billingStatus,
      plan: outlet.organization?.plan,
      trialEndsAt: outlet.organization?.trialEndsAt,
      organizationId: outlet.organization?.id,
      organizationName: outlet.organization?.name,
      counts: { menuItemCount, orderCount, txnCount, tableCount, userCount },
    });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Restaurant Detail] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/restaurants/:id — edit outlet fields
router.patch('/restaurants/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { name, restaurantType, isActive } = req.body;
    const outlet = await basePrisma.outlet.findUnique({ where: { id } });
    if (!outlet) return res.status(404).json({ error: 'Outlet not found' });

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (restaurantType !== undefined) data.restaurantType = restaurantType;
    if (isActive !== undefined) data.isActive = isActive;

    const updated = await basePrisma.outlet.update({ where: { id }, data });
    createAuditLog({
      action: 'SUPERADMIN_EDIT_OUTLET',
      entityType: 'Outlet',
      entityId: id,
      metadata: { changes: data },
    });
    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Edit Outlet] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/restaurants/:id/change-plan — change org plan
router.patch('/restaurants/:id/change-plan', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { plan } = req.body;
    if (!plan) return res.status(400).json({ error: 'plan is required' });

    const outlet = await basePrisma.outlet.findUnique({ where: { id }, select: { organizationId: true } });
    if (!outlet?.organizationId) return res.status(404).json({ error: 'Restaurant not found' });

    await basePrisma.organization.update({
      where: { id: outlet.organizationId },
      data: { plan },
    });
    createAuditLog({
      action: 'SUPERADMIN_CHANGE_PLAN',
      entityType: 'Organization',
      entityId: outlet.organizationId,
      metadata: { outletId: id, newPlan: plan },
    });
    return res.json({ message: `Plan changed to ${plan}` });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Change Plan] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Payments ─────────────────────────────────────────────────────────────────

// GET /api/superadmin/payments — list all onboarding payments
router.get('/payments', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const payments = await basePrisma.onboardingPayment.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await basePrisma.onboardingPayment.count();
    return res.json({ payments, total, page, limit });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Payments] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Monthly Revenue ──────────────────────────────────────────────────────────

// GET /api/superadmin/revenue/monthly — monthly revenue for last 12 months
router.get('/revenue/monthly', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const payments = await basePrisma.onboardingPayment.findMany({
      where: {
        status: 'SUCCESS',
        createdAt: { gte: twelveMonthsAgo },
      },
      select: { amount: true, createdAt: true, plan: true },
    });

    const monthly: Record<string, { month: string; revenue: number; count: number }> = {};
    for (const p of payments) {
      const key = `${p.createdAt.getFullYear()}-${String(p.createdAt.getMonth() + 1).padStart(2, '0')}`;
      if (!monthly[key]) monthly[key] = { month: key, revenue: 0, count: 0 };
      monthly[key].revenue += Number(p.amount);
      monthly[key].count += 1;
    }

    const result = Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month));
    return res.json({ monthly: result });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Revenue] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Plan Config CRUD ─────────────────────────────────────────────────────────

// GET /api/superadmin/plans — list all plan configs
router.get('/plans', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const plans = await basePrisma.planConfig.findMany({ orderBy: { planId: 'asc' } });
    return res.json({ plans });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Plans] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/superadmin/plans — create a new plan config
router.post('/plans', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { planId, name, basePrice, perExtraOutletPrice, includedOutlets, isCustomQuote } = req.body;
    if (!planId || !name) return res.status(400).json({ error: 'planId and name are required' });

    const existing = await basePrisma.planConfig.findUnique({ where: { planId } });
    if (existing) return res.status(409).json({ error: 'Plan with this planId already exists' });

    const plan = await basePrisma.planConfig.create({
      data: {
        planId,
        name,
        basePrice: Number(basePrice) || 0,
        perExtraOutletPrice: Number(perExtraOutletPrice) || 0,
        includedOutlets: Number(includedOutlets) || 1,
        isCustomQuote: Boolean(isCustomQuote),
      },
    });
    createAuditLog({
      action: 'SUPERADMIN_CREATE_PLAN',
      entityType: 'PlanConfig',
      entityId: plan.id,
      metadata: { planId, name },
    });
    invalidatePlanConfigCache();
    return res.status(201).json(plan);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Create Plan] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/plans/:planId — update a plan config
router.patch('/plans/:planId', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const planId = req.params.planId as string;
    const { name, basePrice, perExtraOutletPrice, includedOutlets, isCustomQuote, isActive } = req.body;

    const existing = await basePrisma.planConfig.findUnique({ where: { planId } });
    if (!existing) return res.status(404).json({ error: 'Plan not found' });

    const data: any = {};
    if (name !== undefined) data.name = name;
    if (basePrice !== undefined) data.basePrice = Number(basePrice);
    if (perExtraOutletPrice !== undefined) data.perExtraOutletPrice = Number(perExtraOutletPrice);
    if (includedOutlets !== undefined) data.includedOutlets = Number(includedOutlets);
    if (isCustomQuote !== undefined) data.isCustomQuote = Boolean(isCustomQuote);
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const updated = await basePrisma.planConfig.update({ where: { planId }, data });
    createAuditLog({
      action: 'SUPERADMIN_UPDATE_PLAN',
      entityType: 'PlanConfig',
      entityId: existing.id,
      metadata: { planId, changes: data },
    });
    invalidatePlanConfigCache();
    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Update Plan] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Feature Flags CRUD ───────────────────────────────────────────────────────

// GET /api/superadmin/feature-flags — list all feature flags
router.get('/feature-flags', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const flags = await basePrisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
    return res.json({ flags });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin FeatureFlags] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/superadmin/feature-flags — create a feature flag
router.post('/feature-flags', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { key, description, enabledGlobally, enabledRestaurants } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    const existing = await basePrisma.featureFlag.findUnique({ where: { key } });
    if (existing) return res.status(409).json({ error: 'Feature flag with this key already exists' });

    const flag = await basePrisma.featureFlag.create({
      data: {
        key,
        description: description || null,
        enabledGlobally: Boolean(enabledGlobally),
        enabledRestaurants: Array.isArray(enabledRestaurants) ? enabledRestaurants : [],
      },
    });
    createAuditLog({
      action: 'SUPERADMIN_CREATE_FEATURE_FLAG',
      entityType: 'FeatureFlag',
      entityId: flag.id,
      metadata: { key },
    });
    return res.status(201).json(flag);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Create FeatureFlag] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/feature-flags/:id — update a feature flag
router.patch('/feature-flags/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { description, enabledGlobally, enabledRestaurants } = req.body;

    const existing = await basePrisma.featureFlag.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Feature flag not found' });

    const data: any = {};
    if (description !== undefined) data.description = description;
    if (enabledGlobally !== undefined) data.enabledGlobally = Boolean(enabledGlobally);
    if (enabledRestaurants !== undefined) data.enabledRestaurants = Array.isArray(enabledRestaurants) ? enabledRestaurants : [];

    const updated = await basePrisma.featureFlag.update({ where: { id }, data });
    createAuditLog({
      action: 'SUPERADMIN_UPDATE_FEATURE_FLAG',
      entityType: 'FeatureFlag',
      entityId: id,
      metadata: { key: existing.key, changes: data },
    });
    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Update FeatureFlag] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Announcements CRUD ───────────────────────────────────────────────────────

// GET /api/superadmin/announcements — list all announcements
router.get('/announcements', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const announcements = await basePrisma.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    return res.json({ announcements });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Announcements] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/superadmin/announcements — create an announcement
router.post('/announcements', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { title, body, type, target, activeFrom, activeUntil } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body are required' });

    const announcement = await basePrisma.announcement.create({
      data: {
        title,
        body,
        type: type || 'info',
        target: target || 'all',
        activeFrom: activeFrom ? new Date(activeFrom) : null,
        activeUntil: activeUntil ? new Date(activeUntil) : null,
      },
    });
    createAuditLog({
      action: 'SUPERADMIN_CREATE_ANNOUNCEMENT',
      entityType: 'Announcement',
      entityId: announcement.id,
      metadata: { title, type: type || 'info', target: target || 'all' },
    });
    return res.status(201).json(announcement);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Create Announcement] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/superadmin/announcements/:id — update an announcement
router.patch('/announcements/:id', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { title, body, type, target, isActive, activeFrom, activeUntil } = req.body;

    const existing = await basePrisma.announcement.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Announcement not found' });

    const data: any = {};
    if (title !== undefined) data.title = title;
    if (body !== undefined) data.body = body;
    if (type !== undefined) data.type = type;
    if (target !== undefined) data.target = target;
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (activeFrom !== undefined) data.activeFrom = activeFrom ? new Date(activeFrom) : null;
    if (activeUntil !== undefined) data.activeUntil = activeUntil ? new Date(activeUntil) : null;

    const updated = await basePrisma.announcement.update({ where: { id }, data });
    createAuditLog({
      action: 'SUPERADMIN_UPDATE_ANNOUNCEMENT',
      entityType: 'Announcement',
      entityId: id,
      metadata: { changes: data },
    });
    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Update Announcement] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Audit Logs ───────────────────────────────────────────────────────────────

// GET /api/superadmin/audit-logs — paginated, filterable audit logs
router.get('/audit-logs', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const { restaurantId, action, entityType } = req.query;

    const where: any = {};
    if (restaurantId) where.restaurantId = String(restaurantId);
    if (action) where.action = { contains: String(action), mode: 'insensitive' };
    if (entityType) where.entityType = String(entityType);

    const logs = await basePrisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await basePrisma.auditLog.count({ where });
    return res.json({ logs, total, page, limit });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin AuditLogs] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── System Health ────────────────────────────────────────────────────────────

// GET /api/superadmin/health — DB ping, Redis ping, table counts
router.get('/health', requireSuperAdmin, async (_req: Request, res: Response) => {
  try {
    const dbStart = Date.now();
    await basePrisma.$queryRaw`SELECT 1`;
    const dbPingMs = Date.now() - dbStart;

    let redisStatus = 'not_configured';
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      try {
        const { Redis } = await import('ioredis');
        const redis = new Redis(redisUrl, { connectTimeout: 3000 });
        const redisStart = Date.now();
        await redis.ping();
        const redisPingMs = Date.now() - redisStart;
        redisStatus = `connected (${redisPingMs}ms)`;
        redis.disconnect();
      } catch (redisErr) {
        redisStatus = `error: ${(redisErr as Error).message}`;
      }
    }

    const tableCounts = {
      outlets: await basePrisma.outlet.count(),
      organizations: await basePrisma.organization.count(),
      users: await basePrisma.user.count(),
      orders: await basePrisma.order.count(),
      menuItems: await basePrisma.menuItem.count(),
      transactions: await basePrisma.transaction.count(),
      printQueues: await basePrisma.printQueue.count(),
      auditLogs: await basePrisma.auditLog.count(),
    };

    return res.json({ db: `connected (${dbPingMs}ms)`, redis: redisStatus, tableCounts });
  } catch (error) {
    logger.error({ err: error }, '[SuperAdmin Health] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as superadminRouter };

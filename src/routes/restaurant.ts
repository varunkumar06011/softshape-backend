// ─────────────────────────────────────────────────────────────────────────────
// Restaurant Routes — Restaurant profile, staff lookup, and outlets overview
// ─────────────────────────────────────────────────────────────────────────────
// Manages restaurant (outlet) profile settings, staff lookups for login,
// and multi-outlet organization overview.
//
// Endpoints:
//   GET   /api/restaurant/by-code/:code     — lookup restaurant by join code (for staff login)
//   GET   /api/restaurant/:slug/staff       — list captains/cashiers by slug or code
//   GET   /api/restaurant/me                — current restaurant profile + tables (for QR generation)
//   PATCH /api/restaurant/profile           — update restaurant settings (OWNER/ADMIN only)
//   GET   /api/restaurant/outlets-overview   — all outlets in the organization with summary stats
//
// Profile updates invalidate the tenant context cache for all sibling outlets
// since GST settings are inherited across the organization.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import logger from "../lib/logger";
import prisma from '../lib/prisma';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth';
import { withTenantContext } from '../middleware/tenantContext';
import { invalidateTenantContextCache } from '../lib/tenantContext';

const router = Router();

// GET /api/restaurant/by-code/:code — lookup restaurant by restaurantCode.
// Used during staff login to resolve the restaurant from the join code entered by the user.
// Returns minimal info (id, name, slug, restaurantCode) — no auth required.
router.get('/by-code/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const restaurant = await prisma.outlet.findUnique({ where: { restaurantCode: code } });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    return res.json({
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.slug,
      restaurantCode: restaurant.restaurantCode,
    });
  } catch (error) {
    logger.error({ err: error }, '[Restaurant By Code] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/:slug/staff — list captains/cashiers for a restaurant by slug or restaurantCode
router.get('/:slug/staff', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const rawRole = req.query.role;
    const role = typeof rawRole === 'string' ? rawRole : undefined;

    if (!role || (role !== 'CAPTAIN' && role !== 'CASHIER')) {
      return res.status(400).json({ error: 'role query param must be CAPTAIN or CASHIER' });
    }

    // Resolve by slug or restaurantCode
    const restaurant = await prisma.outlet.findFirst({
      where: {
        OR: [
          { slug },
          { restaurantCode: slug.toUpperCase() },
        ]
      }
    });
    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const users = await prisma.user.findMany({
      where: {
        outletId: restaurant.id,
        role: role as 'CAPTAIN' | 'CASHIER',
        isActive: true
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });

    return res.json({ restaurantId: restaurant.id, staff: users });
  } catch (error) {
    logger.error({ err: error }, '[Staff Lookup] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/me — current restaurant + tables (for QR code generation)
router.get('/me', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const restaurant = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        slug: true,
        restaurantCode: true,
        address: true,
        phone: true,
        email: true,
        gstin: true,
        isActive: true,
        logoUrl: true,
        receiptHeader: true,
        receiptSubHeader: true,
        themePrimary: true,
        themeSecondary: true,
        printerConfig: true,
        barUnitMl: true,
        fullBottleMl: true,
        halfBottleMl: true,
        restaurantType: true,
        outletCount: true,
        fssai: true,
        gstRegistered: true,
        gstCategory: true,
        gstRate: true,
        pricesIncludeGst: true,
        serviceChargePercent: true,
        enabledModules: true,
        organizationId: true,
      }
    });

    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    // Fallback: if outlet has no enabledModules, inherit from organization
    let restaurantWithModules = restaurant as any;
    if (!restaurantWithModules.enabledModules) {
      const org = await prisma.organization.findUnique({
        where: { id: restaurant.organizationId },
        select: { enabledModules: true },
      });
      restaurantWithModules = { ...restaurantWithModules, enabledModules: org?.enabledModules ?? null };
    }

    const tables = await prisma.table.findMany({
      where: { restaurantId },
      select: { id: true, number: true, sectionId: true },
      orderBy: [{ sectionId: 'asc' }, { number: 'asc' }]
    });

    return res.json({ restaurant: restaurantWithModules, tables });
  } catch (error) {
    logger.error({ err: error }, '[Restaurant Me] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/restaurant/profile — update restaurant settings (OWNER / ADMIN only)
router.patch('/profile', authenticate as any, withTenantContext as any, requireRole('OWNER', 'ADMIN') as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const {
      name, address, phone, email, gstin,
      receiptHeader, receiptSubHeader,
      themePrimary, themeSecondary,
      logoUrl, printerConfig,
      barUnitMl, fullBottleMl, halfBottleMl,
      fssai, gstRegistered, gstCategory, gstRate,
      pricesIncludeGst, serviceChargePercent
    } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = String(name).trim();
    if (address !== undefined) updateData.address = String(address).trim() || null;
    if (phone !== undefined) updateData.phone = String(phone).trim() || null;
    if (email !== undefined) updateData.email = String(email).trim() || null;
    if (gstin !== undefined) updateData.gstin = String(gstin).trim().toUpperCase() || null;
    if (receiptHeader !== undefined) updateData.receiptHeader = String(receiptHeader).trim() || null;
    if (receiptSubHeader !== undefined) updateData.receiptSubHeader = String(receiptSubHeader).trim() || null;
    if (themePrimary !== undefined) updateData.themePrimary = String(themePrimary).trim() || null;
    if (themeSecondary !== undefined) updateData.themeSecondary = String(themeSecondary).trim() || null;
    if (logoUrl !== undefined) updateData.logoUrl = String(logoUrl).trim() || null;
    if (printerConfig !== undefined) updateData.printerConfig = printerConfig;
    if (barUnitMl !== undefined) {
      const num = Number(barUnitMl);
      if (!Number.isNaN(num) && num > 0) updateData.barUnitMl = num;
    }
    if (fullBottleMl !== undefined) {
      const num = Number(fullBottleMl);
      if (!Number.isNaN(num) && num > 0) updateData.fullBottleMl = num;
    }
    if (halfBottleMl !== undefined) {
      const num = Number(halfBottleMl);
      if (!Number.isNaN(num) && num > 0) updateData.halfBottleMl = num;
    }
    if (fssai !== undefined) updateData.fssai = String(fssai).trim() || null;
    if (gstRegistered !== undefined) updateData.gstRegistered = Boolean(gstRegistered);
    if (gstCategory !== undefined) {
      const validCategories = ['NON_AC', 'AC', 'TAKEAWAY'];
      const cat = String(gstCategory).trim().toUpperCase();
      if (validCategories.includes(cat)) updateData.gstCategory = cat;
    }
    if (gstRate !== undefined) {
      if (gstRate === null) {
        updateData.gstRate = null;
      } else {
        const num = Number(gstRate);
        if (!Number.isNaN(num) && num >= 0 && num <= 100) updateData.gstRate = num;
      }
    }
    if (pricesIncludeGst !== undefined) updateData.pricesIncludeGst = Boolean(pricesIncludeGst);
    if (serviceChargePercent !== undefined) {
      const num = Number(serviceChargePercent);
      if (!Number.isNaN(num) && num >= 0 && num <= 20) updateData.serviceChargePercent = num;
    }

    const updated = await prisma.outlet.update({
      where: { id: restaurantId },
      data: updateData
    });

    // Invalidate tenant context cache so GST/settings changes propagate immediately
    await invalidateTenantContextCache(restaurantId);
    // Also invalidate cache for all other outlets in the same organization
    const siblingOutlets = await prisma.outlet.findMany({
      where: { organizationId: updated.organizationId, id: { not: restaurantId } },
      select: { id: true },
    });
    await Promise.all(siblingOutlets.map(o => invalidateTenantContextCache(o.id)));

    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[Restaurant Profile] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/restaurant/outlets-overview — all outlets in the organization
router.get('/outlets-overview', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;

    const currentOutlet = await prisma.outlet.findUnique({
      where: { id: restaurantId },
      select: { organizationId: true }
    });
    if (!currentOutlet) {
      return res.status(404).json({ error: 'Outlet not found' });
    }

    const outlets = await prisma.outlet.findMany({
      where: { organizationId: currentOutlet.organizationId },
      include: {
        venues: {
          where: { isDeleted: false },
          include: {
            sections: { include: { _count: { select: { tables: true } } } },
            floors: { include: { sections: { include: { _count: { select: { tables: true } } } } } }
          }
        },
        sections: { where: { venueId: null }, include: { _count: { select: { tables: true } } } },
        _count: { select: { users: true } },
        organization: { select: { plan: true, name: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    const summary = outlets.map(o => {
      const venueSections = [
        ...o.venues.flatMap(v => v.sections),
        ...o.venues.flatMap(v => v.floors.flatMap(f => f.sections))
      ];
      const legacySections = (o.sections ?? []).map(s => ({ ...s, _count: { tables: s._count.tables } }));
      const allSections = [...venueSections, ...legacySections];
      const totalTables = allSections.reduce((sum, s) => sum + s._count.tables, 0);
      const totalVenueCount = o.venues.length + (legacySections.length > 0 && o.venues.length === 0 ? 1 : 0);
      return {
        id: o.id,
        name: o.name,
        restaurantCode: o.restaurantCode,
        restaurantType: o.restaurantType,
        slug: o.slug,
        isActive: o.isActive,
        onboardingCompletedAt: o.onboardingCompletedAt,
        createdAt: o.createdAt,
        venueCount: totalVenueCount,
        venues: o.venues.map(v => ({ name: v.name, venueType: v.venueType })),
        totalSections: allSections.length,
        totalTables,
        staffCount: o._count.users,
        plan: o.organization?.plan ?? null,
        organizationName: o.organization?.name ?? null
      };
    });

    return res.json({ organizationId: currentOutlet.organizationId, outlets: summary });
  } catch (error) {
    logger.error({ err: error }, '[Outlets Overview] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as restaurantRouter };

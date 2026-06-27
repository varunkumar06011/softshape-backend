import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest, requireRole } from '../middleware/auth';
import { withTenantContext } from '../middleware/tenantContext';

const router = Router();

// GET /api/restaurant/by-code/:code — lookup restaurant by restaurantCode
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
    console.error('[Restaurant By Code] Error:', error);
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
    console.error('[Staff Lookup] Error:', error);
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
      }
    });

    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const tables = await prisma.table.findMany({
      where: { restaurantId },
      select: { id: true, number: true, sectionId: true },
      orderBy: [{ sectionId: 'asc' }, { number: 'asc' }]
    });

    return res.json({ restaurant, tables });
  } catch (error) {
    console.error('[Restaurant Me] Error:', error);
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
      barUnitMl, fullBottleMl, halfBottleMl
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

    const updated = await prisma.outlet.update({
      where: { id: restaurantId },
      data: updateData
    });

    return res.json(updated);
  } catch (error) {
    console.error('[Restaurant Profile] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as restaurantRouter };

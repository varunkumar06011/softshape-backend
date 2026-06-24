import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/restaurant/by-code/:code — lookup restaurant by restaurantCode
router.get('/by-code/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code).trim().toUpperCase();
    const restaurant = await prisma.restaurant.findUnique({ where: { restaurantCode: code } });
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
    const restaurant = await prisma.restaurant.findFirst({
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
        restaurantId: restaurant.id,
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
    const restaurantId = r.user!.restaurantId;

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        logoUrl: true,
        receiptHeader: true,
        receiptSubHeader: true,
        themePrimary: true,
        themeSecondary: true,
        printerConfig: true,
        barUnitMl: true,
        fullBottleMl: true,
        plan: true,
        billingStatus: true,
        features: true,
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

export { router as restaurantRouter };

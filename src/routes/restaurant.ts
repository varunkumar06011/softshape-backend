import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';

const router = Router();

// GET /api/restaurant/:slug/staff — list captains/cashiers for a restaurant by slug
router.get('/:slug/staff', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const rawRole = req.query.role;
    const role = typeof rawRole === 'string' ? rawRole : undefined;

    if (!role || (role !== 'CAPTAIN' && role !== 'CASHIER')) {
      return res.status(400).json({ error: 'role query param must be CAPTAIN or CASHIER' });
    }

    const restaurant = await prisma.restaurant.findUnique({ where: { slug } });
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

export { router as restaurantRouter };

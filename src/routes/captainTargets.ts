import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
const router = Router();

// POST /api/captain-targets
// Body: { restaurantId, captainId, revenueTarget, discountLimit }
// Creates or updates a target assignment for a captain.
router.post('/', authenticate, async (req: any, res) => {
  try {
    const { captainId, revenueTarget, discountLimit } = req.body;

    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    if (!captainId || revenueTarget == null || discountLimit == null) {
      return res.status(400).json({ error: 'captainId, revenueTarget, discountLimit are required' });
    }
    const target = await prisma.captainAssignment.upsert({
      where: {
        restaurantId_captainId: {
          restaurantId,
          captainId: String(captainId),
        },
      },
      update: {
        revenueTarget: new Prisma.Decimal(revenueTarget),
        discountLimit: new Prisma.Decimal(discountLimit),
        assignedAt: new Date(),
      },
      create: {
        restaurantId,
        captainId: String(captainId),
        revenueTarget: new Prisma.Decimal(revenueTarget),
        discountLimit: new Prisma.Decimal(discountLimit),
      },
    });
    res.status(201).json(target);
  } catch (err) {
    console.error('[CaptainTargets] POST error:', err);
    res.status(500).json({ error: 'Failed to save target' });
  }
});

// GET /api/captain-targets/:captainId?restaurantId=
// Returns the target for a single captain. 404 if none exists.
router.get('/:captainId', authenticate, async (req: any, res) => {
  try {
    const captainId = req.params.captainId as string;
    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    const target = await prisma.captainAssignment.findUnique({
      where: {
        restaurantId_captainId: {
          restaurantId,
          captainId: String(captainId),
        },
      },
    });
    if (!target) {
      return res.status(404).json({ error: 'No target found' });
    }
    res.json(target);
  } catch (err) {
    console.error('[CaptainTargets] GET/:captainId error:', err);
    res.status(500).json({ error: 'Failed to fetch target' });
  }
});

// GET /api/captain-targets?restaurantId=
// Returns all targets for the restaurant as an array.
router.get('/', authenticate, async (req: any, res) => {
  try {
    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    const targets = await prisma.captainAssignment.findMany({
      where: {},
    });
    res.json(targets);
  } catch (err) {
    console.error('[CaptainTargets] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch targets' });
  }
});

export default router;

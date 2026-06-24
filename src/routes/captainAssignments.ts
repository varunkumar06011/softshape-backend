import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
const router = Router();

// GET /api/captain-assignments?restaurantId=xxx
// Returns all assignments for a restaurant as a map { captainId: { revenueTarget, discountLimit, assignedAt } }
router.get('/', authenticate, async (req: any, res) => {
  try {
    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    const assignments = await prisma.captainAssignment.findMany({
      where: {},
    });
    const map: Record<string, object> = {};
    assignments.forEach(a => {
      map[a.captainId] = {
        revenueTarget: a.revenueTarget,
        discountLimit: a.discountLimit,
        assignedAt: a.assignedAt,
      };
    });
    res.json(map);
  } catch (err) {
    console.error('[CaptainAssignments] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// GET /api/captain-assignments/:captainId?restaurantId=xxx
// Returns a single captain's assignment
router.get('/:captainId', authenticate, async (req: any, res) => {
  try {
    const captainId = req.params.captainId as string;
    const userRestaurantId = req.user?.restaurantId;
    if (!userRestaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const restaurantId = userRestaurantId;

    const assignment = await prisma.captainAssignment.findUnique({
      where: {
        restaurantId_captainId: {
          restaurantId,
          captainId: String(captainId),
        },
      },
    });
    if (!assignment) {
      return res.status(404).json({ error: 'No assignment found' });
    }
    res.json({
      revenueTarget: assignment.revenueTarget,
      discountLimit: assignment.discountLimit,
      assignedAt: assignment.assignedAt,
    });
  } catch (err) {
    console.error('[CaptainAssignments] GET/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch assignment' });
  }
});

// POST /api/captain-assignments
// Body: { restaurantId, captainId, revenueTarget, discountLimit }
// Creates or updates (upsert)
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
    const assignment = await prisma.captainAssignment.upsert({
      where: {
        restaurantId_captainId: {
          restaurantId,
          captainId: String(captainId),
        },
      },
      update: {
        revenueTarget: new Prisma.Decimal(revenueTarget),
        discountLimit: new Prisma.Decimal(discountLimit),
        updatedAt: new Date(),
      },
      create: {
        restaurantId,
        captainId: String(captainId),
        revenueTarget: new Prisma.Decimal(revenueTarget),
        discountLimit: new Prisma.Decimal(discountLimit),
      },
    });
    res.status(201).json({
      revenueTarget: assignment.revenueTarget,
      discountLimit: assignment.discountLimit,
      assignedAt: assignment.assignedAt,
    });
  } catch (err) {
    console.error('[CaptainAssignments] POST error:', err);
    res.status(500).json({ error: 'Failed to save assignment' });
  }
});

export default router;

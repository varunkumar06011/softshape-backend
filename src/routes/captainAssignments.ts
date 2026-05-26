import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// GET /api/captain-assignments?restaurantId=xxx
// Returns all assignments for a restaurant as a map { captainId: { revenueTarget, discountLimit, assignedAt } }
router.get('/', async (req, res) => {
  try {
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }
    const assignments = await prisma.captainAssignment.findMany({
      where: { restaurantId: String(restaurantId) },
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
router.get('/:captainId', async (req, res) => {
  try {
    const { captainId } = req.params;
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }
    const assignment = await prisma.captainAssignment.findUnique({
      where: {
        restaurantId_captainId: {
          restaurantId: String(restaurantId),
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
router.post('/', async (req, res) => {
  try {
    const { restaurantId, captainId, revenueTarget, discountLimit } = req.body;
    if (!restaurantId || !captainId || revenueTarget == null || discountLimit == null) {
      return res.status(400).json({ error: 'restaurantId, captainId, revenueTarget, discountLimit are required' });
    }
    const assignment = await prisma.captainAssignment.upsert({
      where: {
        restaurantId_captainId: {
          restaurantId: String(restaurantId),
          captainId: String(captainId),
        },
      },
      update: {
        revenueTarget: Number(revenueTarget),
        discountLimit: Number(discountLimit),
        updatedAt: new Date(),
      },
      create: {
        restaurantId: String(restaurantId),
        captainId: String(captainId),
        revenueTarget: Number(revenueTarget),
        discountLimit: Number(discountLimit),
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

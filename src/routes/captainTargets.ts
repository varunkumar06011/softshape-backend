import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';

const router = Router();

// POST /api/captain-targets
// Body: { restaurantId, captainId, revenueTarget, discountLimit }
// Creates or updates a target assignment for a captain.
router.post('/', async (req, res) => {
  try {
    const { restaurantId, captainId, revenueTarget, discountLimit } = req.body;
    if (!restaurantId || !captainId || revenueTarget == null || discountLimit == null) {
      return res.status(400).json({ error: 'restaurantId, captainId, revenueTarget, discountLimit are required' });
    }
    const target = await prisma.captainAssignment.upsert({
      where: {
        restaurantId_captainId: {
          restaurantId: String(restaurantId),
          captainId: String(captainId),
        },
      },
      update: {
        revenueTarget: new Prisma.Decimal(revenueTarget),
        discountLimit: new Prisma.Decimal(discountLimit),
        assignedAt: new Date(),
      },
      create: {
        restaurantId: String(restaurantId),
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
router.get('/:captainId', async (req, res) => {
  try {
    const { captainId } = req.params;
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }
    const target = await prisma.captainAssignment.findUnique({
      where: {
        restaurantId_captainId: {
          restaurantId: String(restaurantId),
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
router.get('/', async (req, res) => {
  try {
    const { restaurantId } = req.query;
    if (!restaurantId) {
      return res.status(400).json({ error: 'restaurantId is required' });
    }
    const targets = await prisma.captainAssignment.findMany({
      where: { restaurantId: String(restaurantId) },
    });
    res.json(targets);
  } catch (err) {
    console.error('[CaptainTargets] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch targets' });
  }
});

export default router;

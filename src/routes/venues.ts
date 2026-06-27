import { Router } from 'express';
import logger from "../lib/logger";
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = Router();

function getUserRestaurantId(req: any): string | undefined {
  return req.user?.activeRestaurantId ?? req.user?.restaurantId;
}

// ─── VENUES ──────────────────────────────────────────────────────────────

// GET /api/venues — list all venues for the restaurant
router.get('/', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const venues = await prisma.venue.findMany({
      where: { restaurantId, isDeleted: false },
      orderBy: { sortOrder: 'asc' },
      include: {
        floors: {
          orderBy: { sortOrder: 'asc' },
          include: {
            sections: {
              orderBy: { sortOrder: 'asc' },
              include: {
                tables: { orderBy: { number: 'asc' } },
              },
            },
          },
        },
        sections: {
          where: { floorId: null },
          orderBy: { sortOrder: 'asc' },
          include: {
            tables: { orderBy: { number: 'asc' } },
          },
        },
        priceProfile: { select: { id: true, name: true } },
        taxProfile: { select: { id: true, name: true, gstCategory: true, gstRate: true, serviceChargePercent: true } },
      },
    });

    res.json(venues);
  } catch (err) {
    logger.error({ err }, '[venues/list]');
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
});

// POST /api/venues — create a venue
router.post('/', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name, venueType, priceProfileId, taxProfileId, kotPrinterName, billPrinterName, sortOrder } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const venue = await prisma.venue.create({
      data: {
        restaurantId,
        name: name.trim(),
        venueType: venueType || 'DINE_IN',
        priceProfileId: priceProfileId || null,
        taxProfileId: taxProfileId || null,
        kotPrinterName: kotPrinterName || null,
        billPrinterName: billPrinterName || null,
        sortOrder: sortOrder ?? 0,
      },
    });

    res.status(201).json(venue);
  } catch (err) {
    logger.error({ err }, '[venues/create]');
    res.status(500).json({ error: 'Failed to create venue' });
  }
});

// PATCH /api/venues/:id — update a venue
router.patch('/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { name, venueType, priceProfileId, taxProfileId, kotPrinterName, billPrinterName, sortOrder, isActive } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (venueType !== undefined) updateData.venueType = venueType;
    if (priceProfileId !== undefined) updateData.priceProfileId = priceProfileId || null;
    if (taxProfileId !== undefined) updateData.taxProfileId = taxProfileId || null;
    if (kotPrinterName !== undefined) updateData.kotPrinterName = kotPrinterName || null;
    if (billPrinterName !== undefined) updateData.billPrinterName = billPrinterName || null;
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;
    if (isActive !== undefined) updateData.isActive = isActive;

    const venue = await prisma.venue.update({
      where: { id, restaurantId },
      data: updateData,
    });

    res.json(venue);
  } catch (err) {
    logger.error({ err }, '[venues/update]');
    res.status(500).json({ error: 'Failed to update venue' });
  }
});

// DELETE /api/venues/:id — soft delete
router.delete('/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    await prisma.venue.update({
      where: { id, restaurantId },
      data: { isDeleted: true },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[venues/delete]');
    res.status(500).json({ error: 'Failed to delete venue' });
  }
});

// ─── FLOORS ────────────────────────────────────────────────────────────────

// GET /api/venues/:venueId/floors
router.get('/:venueId/floors', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { venueId } = req.params;
    const floors = await prisma.floor.findMany({
      where: { venueId, restaurantId },
      orderBy: { sortOrder: 'asc' },
      include: {
        sections: {
          orderBy: { sortOrder: 'asc' },
          include: { tables: { orderBy: { number: 'asc' } } },
        },
      },
    });

    res.json(floors);
  } catch (err) {
    logger.error({ err }, '[floors/list]');
    res.status(500).json({ error: 'Failed to fetch floors' });
  }
});

// POST /api/venues/:venueId/floors
router.post('/:venueId/floors', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { venueId } = req.params;
    const { name, sortOrder } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const floor = await prisma.floor.create({
      data: {
        venueId,
        restaurantId,
        name: name.trim(),
        sortOrder: sortOrder ?? 0,
      },
    });

    res.status(201).json(floor);
  } catch (err) {
    logger.error({ err }, '[floors/create]');
    res.status(500).json({ error: 'Failed to create floor' });
  }
});

// PATCH /api/venues/:venueId/floors/:id
router.patch('/:venueId/floors/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { name, sortOrder } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (sortOrder !== undefined) updateData.sortOrder = sortOrder;

    const floor = await prisma.floor.update({
      where: { id, restaurantId },
      data: updateData,
    });

    res.json(floor);
  } catch (err) {
    logger.error({ err }, '[floors/update]');
    res.status(500).json({ error: 'Failed to update floor' });
  }
});

// DELETE /api/venues/:venueId/floors/:id
router.delete('/:venueId/floors/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    // Only delete if no sections reference this floor
    const sectionCount = await prisma.section.count({ where: { floorId: id, restaurantId } });
    if (sectionCount > 0) {
      return res.status(409).json({ error: 'Cannot delete floor with sections. Move or delete sections first.' });
    }

    await prisma.floor.delete({ where: { id, restaurantId } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[floors/delete]');
    res.status(500).json({ error: 'Failed to delete floor' });
  }
});

// ─── PRICE PROFILES ────────────────────────────────────────────────────────

// GET /api/price-profiles
router.get('/price-profiles', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const profiles = await prisma.priceProfile.findMany({
      where: { restaurantId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { items: true, venues: true } },
      },
    });

    res.json(profiles);
  } catch (err) {
    logger.error({ err }, '[price-profiles/list]');
    res.status(500).json({ error: 'Failed to fetch price profiles' });
  }
});

// POST /api/price-profiles
router.post('/price-profiles', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name, isDefault } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const profile = await prisma.priceProfile.create({
      data: {
        restaurantId,
        name: name.trim(),
        isDefault: isDefault ?? false,
      },
    });

    res.status(201).json(profile);
  } catch (err) {
    logger.error({ err }, '[price-profiles/create]');
    res.status(500).json({ error: 'Failed to create price profile' });
  }
});

// PATCH /api/price-profiles/:id
router.patch('/price-profiles/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { name, isDefault } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (isDefault !== undefined) updateData.isDefault = isDefault;

    const profile = await prisma.priceProfile.update({
      where: { id, restaurantId },
      data: updateData,
    });

    res.json(profile);
  } catch (err) {
    logger.error({ err }, '[price-profiles/update]');
    res.status(500).json({ error: 'Failed to update price profile' });
  }
});

// DELETE /api/price-profiles/:id
router.delete('/price-profiles/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const venueCount = await prisma.venue.count({ where: { priceProfileId: id, restaurantId } });
    if (venueCount > 0) {
      return res.status(409).json({ error: 'Cannot delete price profile referenced by venues' });
    }

    await prisma.priceProfile.delete({ where: { id, restaurantId } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[price-profiles/delete]');
    res.status(500).json({ error: 'Failed to delete price profile' });
  }
});

// PUT /api/price-profiles/:id/items — bulk upsert
router.put('/price-profiles/:id/items', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id: priceProfileId } = req.params;
    const { items } = req.body as { items?: Array<{ menuItemId: string; price: number }> };
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'items array is required' });
    }

    const results = await prisma.$transaction(
      items.map((item) =>
        prisma.priceProfileItem.upsert({
          where: { priceProfileId_menuItemId: { priceProfileId, menuItemId: item.menuItemId } },
          create: {
            priceProfileId,
            menuItemId: item.menuItemId,
            price: item.price,
            restaurantId,
          },
          update: { price: item.price },
        })
      )
    );

    res.json({ updated: results.length });
  } catch (err) {
    logger.error({ err }, '[price-profiles/items]');
    res.status(500).json({ error: 'Failed to update price profile items' });
  }
});

// GET /api/price-profiles/:id/items
router.get('/price-profiles/:id/items', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id: priceProfileId } = req.params;

    const profileItems = await prisma.priceProfileItem.findMany({
      where: { priceProfileId, restaurantId },
      include: {
        menuItem: { select: { id: true, name: true, basePrice: true, category: { select: { name: true } } } },
      },
      orderBy: { menuItem: { name: 'asc' } },
    });

    res.json(profileItems);
  } catch (err) {
    logger.error({ err }, '[price-profiles/items-list]');
    res.status(500).json({ error: 'Failed to fetch price profile items' });
  }
});

// ─── TAX PROFILES ──────────────────────────────────────────────────────────

// GET /api/tax-profiles
router.get('/tax-profiles', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const profiles = await prisma.taxProfile.findMany({
      where: { restaurantId },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { venues: true } },
      },
    });

    res.json(profiles);
  } catch (err) {
    logger.error({ err }, '[tax-profiles/list]');
    res.status(500).json({ error: 'Failed to fetch tax profiles' });
  }
});

// POST /api/tax-profiles
router.post('/tax-profiles', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { name, gstCategory, gstRate, gstRegistered, serviceChargePercent, isDefault } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const profile = await prisma.taxProfile.create({
      data: {
        restaurantId,
        name: name.trim(),
        gstCategory: gstCategory || 'NON_AC',
        gstRate: gstRate ?? null,
        gstRegistered: gstRegistered ?? true,
        serviceChargePercent: serviceChargePercent ?? 0,
        isDefault: isDefault ?? false,
      },
    });

    res.status(201).json(profile);
  } catch (err) {
    logger.error({ err }, '[tax-profiles/create]');
    res.status(500).json({ error: 'Failed to create tax profile' });
  }
});

// PATCH /api/tax-profiles/:id
router.patch('/tax-profiles/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;
    const { name, gstCategory, gstRate, gstRegistered, serviceChargePercent, isDefault } = req.body;

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    if (gstCategory !== undefined) updateData.gstCategory = gstCategory;
    if (gstRate !== undefined) updateData.gstRate = gstRate;
    if (gstRegistered !== undefined) updateData.gstRegistered = gstRegistered;
    if (serviceChargePercent !== undefined) updateData.serviceChargePercent = serviceChargePercent;
    if (isDefault !== undefined) updateData.isDefault = isDefault;

    const profile = await prisma.taxProfile.update({
      where: { id, restaurantId },
      data: updateData,
    });

    res.json(profile);
  } catch (err) {
    logger.error({ err }, '[tax-profiles/update]');
    res.status(500).json({ error: 'Failed to update tax profile' });
  }
});

// DELETE /api/tax-profiles/:id
router.delete('/tax-profiles/:id', authenticate, async (req: any, res) => {
  try {
    const restaurantId = getUserRestaurantId(req);
    if (!restaurantId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const venueCount = await prisma.venue.count({ where: { taxProfileId: id, restaurantId } });
    if (venueCount > 0) {
      return res.status(409).json({ error: 'Cannot delete tax profile referenced by venues' });
    }

    await prisma.taxProfile.delete({ where: { id, restaurantId } });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, '[tax-profiles/delete]');
    res.status(500).json({ error: 'Failed to delete tax profile' });
  }
});

export { router as venuesRouter };

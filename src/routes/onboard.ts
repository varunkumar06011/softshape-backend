import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, signToken } from '../lib/auth';
import { allocateRestaurantCode } from '../lib/restaurantCode';

const router = Router();
const prisma = new PrismaClient();

const OutletSchema = z.object({
  name: z.string().min(2),
  restaurantType: z.enum(['DINE_IN', 'BAR_LOUNGE', 'CAFE', 'CLOUD_KITCHEN']).default('DINE_IN'),
  sections: z.array(z.object({
    name: z.string().min(1)
  })).min(1),
  tables: z.array(z.object({
    number: z.number().int().positive(),
    capacity: z.number().int().default(4),
    sectionIndex: z.number().int().min(0)
  })).min(1),
  menu: z.object({
    categories: z.array(z.object({
      name: z.string().min(1),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true)
      })).min(1)
    })).min(1)
  })
});

const OnboardSchema = z.object({
  restaurant: z.object({
    name: z.string().min(2),
    address: z.string().optional(),
    phone: z.string().min(10),
    email: z.string().email().or(z.literal("")).optional(),
    gstin: z.string().min(15).max(15),
    restaurantType: z.enum(['DINE_IN', 'BAR_LOUNGE', 'CAFE', 'CLOUD_KITCHEN']),
    outletCount: z.number().int().min(1).max(10).default(1)
  }),
  owner: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8)
  }),
  captains: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/)
  })).min(1),
  cashiers: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/)
  })).min(1),
  sections: z.array(z.object({
    name: z.string().min(1)
  })).min(1),
  tables: z.array(z.object({
    number: z.number().int().positive(),
    capacity: z.number().int().default(4),
    sectionIndex: z.number().int().min(0)
  })).min(1),
  menu: z.object({
    categories: z.array(z.object({
      name: z.string().min(1),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true)
      })).min(1)
    })).min(1)
  }),
  outlets: z.array(OutletSchema).optional(),
  plan: z.enum(['starter', 'pro', 'enterprise']).default('starter')
});

async function generateUniqueSlug(name: string, tx: any): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  let slug = base;
  let i = 1;
  while (await tx.restaurant.findUnique({ where: { slug } })) {
    slug = `${base}${i++}`;
  }
  return slug;
}

router.post('/', async (req: Request, res: Response) => {
  // Track restaurant IDs for cleanup on partial failure
  const createdRestaurantIds: string[] = [];

  try {
    const data = OnboardSchema.parse(req.body);

    // Pre-check: if email exists, wipe all traces and start fresh
    const existingUser = await prisma.user.findUnique({ where: { email: data.owner.email } });
    if (existingUser) {
      if (existingUser.restaurantId) {
        await prisma.user.deleteMany({ where: { restaurantId: existingUser.restaurantId } });
        await prisma.restaurant.delete({ where: { id: existingUser.restaurantId } }).catch(() => {});
      } else {
        await prisma.user.delete({ where: { id: existingUser.id } });
      }
    }

    // Pre-compute all bcrypt hashes (CPU-bound, must be outside any DB work)
    const ownerHash = await hashPassword(data.owner.password);
    const captainHashes = await Promise.all(data.captains.map(c => hashPassword(c.pin)));
    const cashierHashes = await Promise.all(data.cashiers.map(c => hashPassword(c.pin)));
    const slug = await generateUniqueSlug(data.restaurant.name, prisma);

    // ── Sequential DB operations (no $transaction — PgBouncer pooling incompatible) ──

    // 1. Create parent Restaurant
    const restaurant = await prisma.restaurant.create({
      data: {
        name: data.restaurant.name,
        address: data.restaurant.address || null,
        phone: data.restaurant.phone,
        email: data.restaurant.email || null,
        gstin: data.restaurant.gstin,
        restaurantType: data.restaurant.restaurantType,
        outletCount: data.restaurant.outletCount,
        slug,
        plan: data.plan,
        restaurantCode: 'PENDING'
      }
    });
    createdRestaurantIds.push(restaurant.id);
    const rid = restaurant.id;

    // 2. Atomic restaurantCode allocation
    const restaurantCode = await allocateRestaurantCode();
    await prisma.restaurant.update({ where: { id: rid }, data: { restaurantCode } });

    // 3. Owner
    const owner = await prisma.user.create({
      data: { name: data.owner.name, email: data.owner.email, passwordHash: ownerHash, role: 'OWNER', restaurantId: rid }
    });

    // 4. Captains + Cashiers (parallel batches)
    await Promise.all([
      ...data.captains.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: captainHashes[i], role: 'CAPTAIN', restaurantId: rid }
      })),
      ...data.cashiers.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: cashierHashes[i], role: 'CASHIER', restaurantId: rid }
      }))
    ]);

    // 5. Main outlet: Sections + Tables + Menu
    const createdSections = await Promise.all(
      data.sections.map(s => prisma.section.create({ data: { name: s.name, restaurantId: rid } }))
    );

    await Promise.all(
      data.tables.map(t => prisma.table.create({
        data: { number: t.number, capacity: t.capacity, sectionId: createdSections[t.sectionIndex].id, restaurantId: rid }
      }))
    );

    for (const cat of data.menu.categories) {
      const category = await prisma.category.create({ data: { name: cat.name, restaurantId: rid } });
      await Promise.all(cat.items.map(item => prisma.menuItem.create({
        data: { name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD', categoryId: category.id, restaurantId: rid }
      })));
    }

    // 6. DailyCounter seed for main restaurant
    const today = new Date().toISOString().slice(0, 10);
    await prisma.dailyCounter.create({ data: { restaurantId: rid, counterDate: today } });

    // 7. Create additional outlets (if outletCount > 1 and outlets array provided)
    const outletIds: string[] = [rid];
    if (data.restaurant.outletCount > 1 && data.outlets && data.outlets.length > 0) {
      for (let i = 0; i < data.outlets.length && i < data.restaurant.outletCount - 1; i++) {
        const outletData = data.outlets[i];
        const outletSlug = await generateUniqueSlug(outletData.name, prisma);

        const outlet = await prisma.restaurant.create({
          data: {
            name: outletData.name,
            slug: outletSlug,
            plan: data.plan,
            restaurantCode,
            restaurantType: outletData.restaurantType,
            outletCount: 1,
            parentRestaurantId: rid,
            gstin: data.restaurant.gstin,
            phone: data.restaurant.phone,
            email: data.restaurant.email || null,
            address: data.restaurant.address || null,
          }
        });
        createdRestaurantIds.push(outlet.id);
        outletIds.push(outlet.id);

        // Create sections + tables for outlet
        const outletSections = await Promise.all(
          outletData.sections.map(s => prisma.section.create({ data: { name: s.name, restaurantId: outlet.id } }))
        );

        await Promise.all(
          outletData.tables.map(t => prisma.table.create({
            data: { number: t.number, capacity: t.capacity, sectionId: outletSections[t.sectionIndex].id, restaurantId: outlet.id }
          }))
        );

        // Create menu for outlet
        for (const cat of outletData.menu.categories) {
          const category = await prisma.category.create({ data: { name: cat.name, restaurantId: outlet.id } });
          await Promise.all(cat.items.map(item => prisma.menuItem.create({
            data: { name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD', categoryId: category.id, restaurantId: outlet.id }
          })));
        }

        // DailyCounter for outlet
        await prisma.dailyCounter.create({ data: { restaurantId: outlet.id, counterDate: today } });
      }
    }

    console.log(`[Onboard] Restaurant created: ${slug} (${restaurantCode}) with ${outletIds.length} outlet(s)`);

    const token = signToken({ userId: owner.id, email: owner.email!, role: 'OWNER', restaurantId: rid, restaurantCode, slug });

    return res.status(201).json({
      token,
      user: { id: owner.id, name: owner.name, email: owner.email, role: 'OWNER', restaurantId: rid },
      restaurant: { id: rid, name: restaurant.name, slug, restaurantCode, outletIds }
    });

  } catch (error: any) {
    // Cleanup: delete all created restaurants (cascades all children)
    for (const id of createdRestaurantIds) {
      try { await prisma.restaurant.delete({ where: { id } }); } catch {}
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    console.error('[Onboard] Error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error?.message || String(error) });
  }
});

export { router as onboardRouter };

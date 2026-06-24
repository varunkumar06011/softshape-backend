import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, signToken } from '../lib/auth';

const router = Router();
const prisma = new PrismaClient();

const OnboardSchema = z.object({
  restaurant: z.object({
    name: z.string().min(2),
    address: z.string().optional(),
    phone: z.string().min(10),
    email: z.string().email().optional(),
    gstin: z.string().optional()
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
  // Track restaurant ID for cleanup on partial failure
  let restaurantId: string | null = null;

  try {
    const data = OnboardSchema.parse(req.body);

    // Pre-check: email uniqueness (clean up orphaned users from failed attempts)
    const existingUser = await prisma.user.findUnique({ where: { email: data.owner.email } });
    if (existingUser) {
      // Check if the user has a valid restaurant
      const linkedRestaurant = existingUser.restaurantId
        ? await prisma.restaurant.findUnique({ where: { id: existingUser.restaurantId } })
        : null;
      if (!linkedRestaurant) {
        // Orphaned user from a previous failed onboarding — safe to delete
        await prisma.user.delete({ where: { id: existingUser.id } });
      } else {
        return res.status(409).json({ error: 'Email already registered', detail: `The email "${data.owner.email}" is already in use by an active restaurant. Please use a different email or log in.` });
      }
    }

    // Pre-compute all bcrypt hashes (CPU-bound, must be outside any DB work)
    const ownerHash = await hashPassword(data.owner.password);
    const captainHashes = await Promise.all(data.captains.map(c => hashPassword(c.pin)));
    const cashierHashes = await Promise.all(data.cashiers.map(c => hashPassword(c.pin)));
    const slug = await generateUniqueSlug(data.restaurant.name, prisma);

    // ── Sequential DB operations (no $transaction — PgBouncer pooling incompatible) ──

    // 1. Create Restaurant
    const restaurant = await prisma.restaurant.create({
      data: { ...data.restaurant, slug, plan: data.plan }
    });
    restaurantId = restaurant.id;

    // 2. Sequential restaurantCode
    const count = await prisma.restaurant.count();
    const restaurantCode = `RESTAURANT-${String(count).padStart(3, '0')}`;
    await prisma.restaurant.update({ where: { id: restaurantId }, data: { restaurantCode } });

    const rid = restaurant.id;

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

    // 5. Sections
    const createdSections = await Promise.all(
      data.sections.map(s => prisma.section.create({ data: { name: s.name, restaurantId: rid } }))
    );

    // 6. Tables (parallel)
    await Promise.all(
      data.tables.map(t => prisma.table.create({
        data: { number: t.number, capacity: t.capacity, sectionId: createdSections[t.sectionIndex].id, restaurantId: rid }
      }))
    );

    // 7. Menu categories + items
    for (const cat of data.menu.categories) {
      const category = await prisma.category.create({ data: { name: cat.name, restaurantId: rid } });
      await Promise.all(cat.items.map(item => prisma.menuItem.create({
        data: { name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD', categoryId: category.id, restaurantId: rid }
      })));
    }

    // 8. DailyCounter seed
    const today = new Date().toISOString().slice(0, 10);
    await prisma.dailyCounter.create({ data: { restaurantId: rid, counterDate: today } });

    console.log(`[Onboard] Restaurant created: ${slug} (${restaurantCode})`);

    const token = signToken({ userId: owner.id, email: owner.email!, role: 'OWNER', restaurantId: rid, slug });

    return res.status(201).json({
      token,
      user: { id: owner.id, name: owner.name, email: owner.email, role: 'OWNER', restaurantId: rid },
      restaurant: { id: rid, name: restaurant.name, slug, restaurantCode }
    });

  } catch (error: any) {
    // Cleanup: if restaurant was created but subsequent steps failed, delete it (cascades all children)
    if (restaurantId) {
      try { await prisma.restaurant.delete({ where: { id: restaurantId } }); } catch {}
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    console.error('[Onboard] Error:', error);
    return res.status(500).json({ error: 'Internal server error', detail: error?.message || String(error) });
  }
});

export { router as onboardRouter };

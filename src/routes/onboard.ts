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
  try {
    const data = OnboardSchema.parse(req.body);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Generate unique slug from restaurant name
      const slug = await generateUniqueSlug(data.restaurant.name, tx);

      // 2. Create Restaurant
      const restaurant = await tx.restaurant.create({
        data: {
          ...data.restaurant,
          slug,
          plan: data.plan
        }
      });

      // 3. Owner user (email + hashed password)
      const ownerHash = await hashPassword(data.owner.password);
      const owner = await tx.user.create({
        data: {
          name: data.owner.name,
          email: data.owner.email,
          passwordHash: ownerHash,
          role: 'OWNER',
          restaurantId: restaurant.id
        }
      });

      // 4. Captains (hashed PIN, no email)
      for (const c of data.captains) {
        const pinHash = await hashPassword(c.pin);
        await tx.user.create({
          data: {
            name: c.name,
            pin: pinHash,
            role: 'CAPTAIN',
            restaurantId: restaurant.id
          }
        });
      }

      // 5. Cashiers (hashed PIN, no email)
      for (const c of data.cashiers) {
        const pinHash = await hashPassword(c.pin);
        await tx.user.create({
          data: {
            name: c.name,
            pin: pinHash,
            role: 'CASHIER',
            restaurantId: restaurant.id
          }
        });
      }

      // 6. Sections
      const createdSections = await Promise.all(
        data.sections.map(s => tx.section.create({
          data: {
            name: s.name,
            restaurantId: restaurant.id
          }
        }))
      );

      // 7. Tables
      for (const t of data.tables) {
        await tx.table.create({
          data: {
            number: t.number,
            capacity: t.capacity,
            sectionId: createdSections[t.sectionIndex].id,
            restaurantId: restaurant.id
          }
        });
      }

      // 8. Menu — categories + items (menuType hardcoded FOOD)
      for (const cat of data.menu.categories) {
        const category = await tx.category.create({
          data: {
            name: cat.name,
            restaurantId: restaurant.id
          }
        });
        for (const item of cat.items) {
          await tx.menuItem.create({
            data: {
              name: item.name,
              basePrice: item.price,
              isVeg: item.isVeg,
              isAvailable: true,
              menuType: 'FOOD',
              categoryId: category.id,
              restaurantId: restaurant.id
            }
          });
        }
      }

      // 9. Seed DailyCounter for today
      const today = new Date().toISOString().slice(0, 10);
      await tx.dailyCounter.create({
        data: {
          restaurantId: restaurant.id,
          counterDate: today
        }
      });

      // 10. Email verification — stub (log to console; real email in Week 2)
      console.log(`[Onboard] Verification email queued for ${data.owner.email} (restaurant: ${slug})`);

      return { restaurant, owner };
    });

    const token = signToken({
      userId: result.owner.id,
      email: result.owner.email!,
      role: 'OWNER',
      restaurantId: result.restaurant.id,
      slug: result.restaurant.slug
    });

    return res.status(201).json({
      token,
      user: {
        id: result.owner.id,
        name: result.owner.name,
        email: result.owner.email,
        role: 'OWNER',
        restaurantId: result.restaurant.id
      },
      restaurant: {
        id: result.restaurant.id,
        name: result.restaurant.name,
        slug: result.restaurant.slug
      }
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    console.error('[Onboard] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as onboardRouter };

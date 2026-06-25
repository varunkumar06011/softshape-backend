import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { hashPassword, signToken } from '../lib/auth';
import { basePrisma as prisma } from '../lib/prisma';
import { sendWelcomeEmail } from '../lib/email';
import { computePlanPrice } from '../config/pricing';
import { getPaymentGateway } from '../services/paymentGateway';
import { computeEnabledModules } from '../lib/moduleDefaults';
import { checkVerificationProof } from '../lib/verificationToken';

const router = Router();

async function allocateRestaurantCode(): Promise<string> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempts = 0; attempts < 10; attempts++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const existing = await prisma.restaurant.findUnique({ where: { restaurantCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to allocate unique restaurantCode after 10 attempts');
}

const OutletSchema = z.object({
  name: z.string().min(2),
  restaurantType: z.enum(['DINE_IN', 'BAR_LOUNGE', 'BAR_WITH_DINING', 'CAFE', 'CLOUD_KITCHEN']).default('DINE_IN'),
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
    gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format'),
    restaurantType: z.enum(['DINE_IN', 'BAR_LOUNGE', 'BAR_WITH_DINING', 'CAFE', 'CLOUD_KITCHEN']),
    outletCount: z.number().int().min(1).max(10).default(1),
    barUnitMl: z.preprocess((val) => (val == null ? 30 : val), z.number().int().positive()),
    fullBottleMl: z.preprocess((val) => (val == null ? 750 : val), z.number().int().positive()),
    halfBottleMl: z.preprocess((val) => (val == null ? 375 : val), z.number().int().positive()),
    deliveryPlatforms: z.array(z.string()).optional()
  }),
  branding: z.object({
    receiptHeader: z.string(),
    receiptSubHeader: z.string().optional(),
    fssai: z.string().optional(),
    themePrimary: z.string().optional(),
    logoUrl: z.string().optional()
  }).optional(),
  taxConfig: z.object({
    gstRegistered: z.boolean(),
    gstCategory: z.enum(['NON_AC', 'AC', 'TAKEAWAY']).optional(),
    pricesIncludeGst: z.boolean().default(false),
    serviceChargePercent: z.number().min(0).max(20).default(0)
  }).optional(),
  owner: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
    password: z.string().min(8)
  }),
  captains: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/)
  })).min(1).optional().default([]),
  cashiers: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/)
  })).min(1),
  sections: z.array(z.object({
    name: z.string().min(1)
  })).min(1).optional().default([]),
  tables: z.array(z.object({
    number: z.number().int().positive(),
    capacity: z.number().int().default(4),
    sectionIndex: z.number().int().min(0)
  })).min(1).optional().default([]),
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
  printers: z.array(z.object({
    name: z.string(),
    paperWidth: z.enum(['58mm', '80mm']),
    type: z.enum(['KITCHEN', 'BAR', 'BILL', 'ALL'])
  })).optional(),
  sectionRouting: z.record(z.string(), z.string()).optional(),
  outlets: z.array(OutletSchema).optional(),
  plan: z.enum(['starter', 'pro', 'enterprise']).default('starter'),
  paymentReference: z.string().min(1, 'Payment must be completed before onboarding'),
  sessionId: z.string().min(1, 'Session ID is required'),
  emailVerificationProof: z.string().min(1, 'Email must be verified'),
  phoneVerificationProof: z.string().min(1, 'Phone must be verified')
});

// POST /api/onboard/pricing/quote — public, no auth, no side effects. Single source of truth for price.
router.post('/pricing/quote', (req, res) => {
  try {
    const { plan, numberOfOutlets } = req.body;
    if (!plan || !numberOfOutlets) return res.status(400).json({ error: 'plan and numberOfOutlets are required' });
    return res.json(computePlanPrice(plan, Number(numberOfOutlets)));
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

// POST /api/onboard/payment/mock — creates + instantly settles a mock payment intent.
router.post('/payment/mock', async (req, res) => {
  try {
    const { plan, numberOfOutlets, sessionId } = req.body;
    if (!plan || !numberOfOutlets || !sessionId) {
      return res.status(400).json({ error: 'plan, numberOfOutlets, sessionId are required' });
    }
    const quote = computePlanPrice(plan, Number(numberOfOutlets));
    const gateway = getPaymentGateway();
    const order = await gateway.createOrder({ amount: quote.totalMonthly, currency: 'INR', sessionId });
    const verify = await gateway.verifyPayment({ gatewayOrderId: order.gatewayOrderId, payload: {} });

    const payment = await prisma.onboardingPayment.create({
      data: {
        sessionId, plan, numberOfOutlets: Number(numberOfOutlets),
        amount: quote.totalMonthly, currency: 'INR', gateway: 'MOCK',
        status: verify.success ? 'SUCCESS' : 'FAILED',
        gatewayOrderId: order.gatewayOrderId,
        gatewayPaymentId: verify.gatewayPaymentId,
      },
    });

    if (!verify.success) return res.status(402).json({ error: 'Payment failed', reason: verify.reason });
    return res.status(201).json({ paymentReference: payment.id, amount: quote.totalMonthly, currency: 'INR' });
  } catch (err: any) {
    console.error('[Onboard Payment Mock] Error:', err);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
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

    // Verification proof guards — prevent someone from verifying one email/phone and submitting different values
    const emailOk = checkVerificationProof(data.emailVerificationProof, 'email', data.owner.email.toLowerCase(), data.sessionId);
    if (!emailOk) return res.status(400).json({ error: 'Email verification invalid or expired — please re-verify' });

    const phoneOk = checkVerificationProof(data.phoneVerificationProof, 'phone', data.owner.phone, data.sessionId);
    if (!phoneOk) return res.status(400).json({ error: 'Phone verification invalid or expired — please re-verify' });

    // Payment verification guard — before any restaurant creation
    const payment = await prisma.onboardingPayment.findUnique({ where: { id: data.paymentReference } });
    if (!payment || payment.status !== 'SUCCESS' || payment.plan !== data.plan || payment.numberOfOutlets !== data.restaurant.outletCount) {
      return res.status(402).json({ error: 'Valid payment is required before completing onboarding' });
    }

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
    const priceQuote = computePlanPrice(data.plan, data.restaurant.outletCount);
    const enabledModules = computeEnabledModules({
      restaurantType: data.restaurant.restaurantType,
    });

    const restaurant = await prisma.restaurant.create({
      data: {
        name: data.restaurant.name,
        address: data.restaurant.address || null,
        phone: data.restaurant.phone,
        email: data.restaurant.email || null,
        gstin: data.restaurant.gstin,
        restaurantType: data.restaurant.restaurantType,
        outletCount: data.restaurant.outletCount,
        barUnitMl: data.restaurant.barUnitMl ?? 30,
        fullBottleMl: data.restaurant.fullBottleMl ?? 750,
        halfBottleMl: data.restaurant.halfBottleMl ?? 375,
        deliveryPlatforms: data.restaurant.deliveryPlatforms || [],
        receiptHeader: data.branding?.receiptHeader ?? data.restaurant.name,
        receiptSubHeader: data.branding?.receiptSubHeader ?? null,
        themePrimary: data.branding?.themePrimary ?? '#E53935',
        fssai: data.branding?.fssai ?? null,
        logoUrl: data.branding?.logoUrl ?? null,
        pricesIncludeGst: data.taxConfig?.pricesIncludeGst ?? false,
        serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
        slug,
        plan: data.plan,
        restaurantCode: 'PENDING',
        enabledModules,
        planPriceSnapshot: priceQuote.totalMonthly,
        paymentStatus: 'MOCK_PAID',
        paymentReference: data.paymentReference,
        onboardingCompletedAt: new Date(),
      }
    });
    createdRestaurantIds.push(restaurant.id);
    const rid = restaurant.id;

    // 2. Atomic restaurantCode allocation
    const restaurantCode = await allocateRestaurantCode();
    await prisma.restaurant.update({ where: { id: rid }, data: { restaurantCode } });
    (restaurant as any).restaurantCode = restaurantCode;

    // 3. Owner
    const owner = await prisma.user.create({
      data: { name: data.owner.name, email: data.owner.email, passwordHash: ownerHash, role: 'OWNER', restaurantId: rid }
    });

    // Fire-and-forget welcome email (don't block onboarding on email failure)
    sendWelcomeEmail(owner.email!, owner.name, restaurant.name, restaurantCode).catch(() => {});

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

        const outletCode = await allocateRestaurantCode();
        const outlet = await prisma.restaurant.create({
          data: {
            name: outletData.name,
            slug: outletSlug,
            plan: data.plan,
            restaurantCode: outletCode,
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

    // Link payment record to restaurant
    await prisma.onboardingPayment.update({ where: { id: data.paymentReference }, data: { restaurantId: restaurant.id } });

    console.log(`[Onboard] Restaurant created: ${slug} (${restaurantCode}) with ${outletIds.length} outlet(s)`);

    const token = signToken({ userId: owner.id, email: owner.email!, role: 'OWNER', restaurantId: rid, restaurantCode, slug });

    return res.status(201).json({
      token,
      user: { id: owner.id, name: owner.name, email: owner.email, role: 'OWNER', restaurantId: rid },
      restaurant: { ...restaurant, outletIds }
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

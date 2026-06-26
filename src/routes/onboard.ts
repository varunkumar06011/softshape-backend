import { Router, Request, Response } from 'express';
import crypto from 'crypto';
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
  for (let attempts = 0; attempts < 100; attempts++) {
    const randomBytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(randomBytes[i] % chars.length);
    }
    const existing = await prisma.restaurant.findUnique({ where: { restaurantCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to allocate unique restaurantCode after 100 attempts');
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
    gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, 'Invalid GSTIN format').optional().or(z.literal('')),
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
    serviceChargePercent: z.number().min(0).max(20).default(0),
    packagingCharge: z.number().default(0)
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
  barMenu: z.object({
    categories: z.array(z.object({
      name: z.string().min(1),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true)
      })).min(1)
    })).min(1)
  }).optional(),
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
  const start = Date.now();
  const { plan, numberOfOutlets, sessionId } = req.body || {};
  console.log(`[Onboard Payment Mock] Request received`, { plan, numberOfOutlets, sessionId });
  try {
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

    console.log(`[Onboard Payment Mock] Success in ${Date.now() - start}ms`, { paymentId: payment.id, amount: quote.totalMonthly });
    if (!verify.success) return res.status(402).json({ error: 'Payment failed', reason: verify.reason });
    return res.status(201).json({ paymentReference: payment.id, amount: quote.totalMonthly, currency: 'INR' });
  } catch (err: any) {
    console.error(`[Onboard Payment Mock] Error after ${Date.now() - start}ms:`, err);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
});

// POST /api/onboard/payment/initiate — creates a Razorpay (or mock) order.
router.post('/payment/initiate', async (req, res) => {
  try {
    const { plan, numberOfOutlets, sessionId } = req.body;
    if (!plan || !numberOfOutlets || !sessionId) {
      return res.status(400).json({ error: 'plan, numberOfOutlets, sessionId are required' });
    }
    const quote = computePlanPrice(plan, Number(numberOfOutlets));
    const gateway = getPaymentGateway();
    const order = await gateway.createOrder({ amount: quote.totalMonthly, currency: 'INR', sessionId });

    const gatewayName = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? 'RAZORPAY' : 'MOCK';

    const payment = await prisma.onboardingPayment.create({
      data: {
        sessionId, plan, numberOfOutlets: Number(numberOfOutlets),
        amount: quote.totalMonthly, currency: 'INR', gateway: gatewayName,
        status: 'CREATED',
        gatewayOrderId: order.gatewayOrderId,
      },
    });

    return res.status(201).json({ gatewayOrderId: order.gatewayOrderId, amount: quote.totalMonthly, currency: 'INR' });
  } catch (err: any) {
    console.error('[Onboard Payment Initiate] Error:', err);
    return res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// POST /api/onboard/payment/verify — verifies Razorpay signature and settles payment.
router.post('/payment/verify', async (req, res) => {
  try {
    const { gatewayOrderId, razorpay_payment_id, razorpay_signature, sessionId } = req.body;
    if (!gatewayOrderId || !razorpay_payment_id || !razorpay_signature || !sessionId) {
      return res.status(400).json({ error: 'gatewayOrderId, razorpay_payment_id, razorpay_signature, sessionId are required' });
    }

    const payment = await prisma.onboardingPayment.findFirst({
      where: { gatewayOrderId, sessionId, status: 'CREATED' },
    });
    if (!payment) {
      return res.status(404).json({ error: 'Payment record not found or already processed' });
    }

    const gateway = getPaymentGateway();
    const verify = await gateway.verifyPayment({
      gatewayOrderId,
      payload: { razorpay_payment_id, razorpay_signature },
    });

    if (!verify.success) {
      await prisma.onboardingPayment.update({
        where: { id: payment.id },
        data: { status: 'FAILED', gatewayPaymentId: razorpay_payment_id },
      });
      return res.status(402).json({ error: 'Payment verification failed', reason: verify.reason });
    }

    await prisma.onboardingPayment.update({
      where: { id: payment.id },
      data: { status: 'SUCCESS', gatewayPaymentId: verify.gatewayPaymentId },
    });

    return res.status(200).json({ paymentReference: payment.id });
  } catch (err: any) {
    console.error('[Onboard Payment Verify] Error:', err);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
});

async function generateUniqueSlug(name: string, tx: any): Promise<string> {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  let slug = base;
  let attempts = 0;
  while (await tx.restaurant.findUnique({ where: { slug } })) {
    const suffix = crypto.randomBytes(2).toString('hex').slice(0, 3);
    slug = `${base}${suffix}`;
    attempts++;
    if (attempts > 20) {
      slug = `${base}${Date.now()}`;
      break;
    }
  }
  return slug;
}

router.post('/', async (req: Request, res: Response) => {
  // Track IDs for cleanup on partial failure
  const createdRestaurantIds: string[] = [];
  const createdUserIds: string[] = [];

  try {
    const data = OnboardSchema.parse(req.body);

    // Verification proof guards — prevent someone from verifying one email/phone and submitting different values
    const emailOk = checkVerificationProof(data.emailVerificationProof, 'email', data.owner.email.toLowerCase(), data.sessionId);
    if (!emailOk) {
      console.error('[Onboard] Email verification failed:', { email: data.owner.email.toLowerCase(), sessionId: data.sessionId });
      return res.status(400).json({ error: 'Email verification invalid or expired — please re-verify' });
    }

    const normalizedPhone = data.owner.phone.startsWith('+') ? data.owner.phone : '+91' + data.owner.phone.replace(/\D/g, '').slice(-10);
    const phoneOk = checkVerificationProof(data.phoneVerificationProof, 'phone', normalizedPhone, data.sessionId);
    if (!phoneOk) {
      console.error('[Onboard] Phone verification failed:', { phone: normalizedPhone, sessionId: data.sessionId });
      return res.status(400).json({ error: 'Phone verification invalid or expired — please re-verify' });
    }

    // Payment verification guard — before any restaurant creation
    const payment = await prisma.onboardingPayment.findUnique({ where: { id: data.paymentReference } });
    if (!payment || payment.status !== 'SUCCESS' || payment.plan !== data.plan || payment.numberOfOutlets !== data.restaurant.outletCount) {
      return res.status(402).json({ error: 'Valid payment is required before completing onboarding' });
    }

    // Pre-check: if email exists, only allow restart if the linked restaurant has no live data
    const existingUser = await prisma.user.findFirst({ where: { email: data.owner.email } });
    if (existingUser) {
      if (existingUser.restaurantId) {
        const [orderCount, txnCount] = await Promise.all([
          prisma.order.count({ where: { restaurantId: existingUser.restaurantId } }),
          prisma.transaction.count({ where: { restaurantId: existingUser.restaurantId } }),
        ]);
        if (orderCount > 0 || txnCount > 0) {
          return res.status(409).json({
            error: 'This email already manages a live restaurant with orders or transactions. Use a different email or contact support.',
          });
        }
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

    // 1. Allocate a unique code BEFORE creating the restaurant so we never
    // insert the temporary 'PENDING' value that collides under concurrent onboardings.
    const restaurantCode = await allocateRestaurantCode();

    // 2. Create parent Restaurant
    const priceQuote = computePlanPrice(data.plan, data.restaurant.outletCount);
    const enabledModules = computeEnabledModules({
      restaurantType: data.restaurant.restaurantType,
    });

    // Build features JSON: taxConfig + deliveryPlatforms for cloud kitchen
    const features: Record<string, any> = {};
    if (data.taxConfig) {
      features.taxConfig = {
        gstRegistered: data.taxConfig.gstRegistered,
        gstCategory: data.taxConfig.gstCategory,
        pricesIncludeGst: data.taxConfig.pricesIncludeGst,
        serviceChargePercent: data.taxConfig.serviceChargePercent,
        packagingCharge: data.taxConfig.packagingCharge ?? 0,
      };
    }
    if (data.restaurant.restaurantType === 'CLOUD_KITCHEN' && data.restaurant.deliveryPlatforms?.length) {
      features.deliveryPlatforms = data.restaurant.deliveryPlatforms;
    }

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
        gstCategory: data.taxConfig?.gstCategory ?? 'NON_AC',
        serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
        features: Object.keys(features).length > 0 ? features : undefined,
        slug,
        plan: data.plan,
        restaurantCode,
        enabledModules,
        planPriceSnapshot: priceQuote.totalMonthly,
        paymentStatus: payment.gateway === 'RAZORPAY' ? 'PAID' : 'MOCK_PAID',
        paymentReference: data.paymentReference,
        onboardingCompletedAt: new Date(),
        billingStatus: 'active',
      }
    });
    createdRestaurantIds.push(restaurant.id);
    const rid = restaurant.id;
    (restaurant as any).restaurantCode = restaurantCode;

    // 3. Owner
    const owner = await prisma.user.create({
      data: { name: data.owner.name, email: data.owner.email, passwordHash: ownerHash, role: 'OWNER', restaurantId: rid }
    });
    createdUserIds.push(owner.id);

    // Fire-and-forget welcome email (don't block onboarding on email failure)
    sendWelcomeEmail(owner.email!, owner.name, restaurant.name, restaurantCode).catch(() => {});

    // 4. Captains + Cashiers (parallel batches)
    const createdStaff = await Promise.all([
      ...data.captains.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: captainHashes[i], role: 'CAPTAIN', restaurantId: rid }
      })),
      ...data.cashiers.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: cashierHashes[i], role: 'CASHIER', restaurantId: rid }
      }))
    ]);
    createdStaff.forEach(u => createdUserIds.push(u.id));

    // 5. Main outlet: Sections + Tables + Menu
    // Default sections for CAFE and CLOUD_KITCHEN when floorplan step is skipped
    let sectionsToCreate = data.sections;
    if (sectionsToCreate.length === 0) {
      if (data.restaurant.restaurantType === 'CAFE') {
        sectionsToCreate = [{ name: 'Counter' }];
      } else if (data.restaurant.restaurantType === 'CLOUD_KITCHEN') {
        sectionsToCreate = [{ name: 'Kitchen' }];
      }
    }

    const createdSections = await Promise.all(
      sectionsToCreate.map(s => prisma.section.create({ data: { name: s.name, restaurantId: rid } }))
    );

    await Promise.all(
      data.tables.map(t => prisma.table.create({
        data: { number: t.number, capacity: t.capacity, sectionId: createdSections[t.sectionIndex].id, restaurantId: rid }
      }))
    );

    for (const cat of data.menu.categories) {
      const category = await prisma.category.create({ data: { name: cat.name, restaurantId: rid } });
      await Promise.all(cat.items.map(item => prisma.menuItem.create({
        data: {
          name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD',
          categoryId: category.id, restaurantId: rid,
          venuePrices: {
            create: createdSections.map(s => ({
              venueId: s.id,
              price: item.price,
              isActive: true,
              restaurantId: rid,
            }))
          }
        }
      })));
    }

    // 5b. Bar menu (liquor) for bar-type restaurants
    if (data.barMenu?.categories) {
      for (const cat of data.barMenu.categories) {
        const category = await prisma.category.create({ data: { name: cat.name, restaurantId: rid } });
        await Promise.all(cat.items.map(item => prisma.menuItem.create({
          data: {
            name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'LIQUOR',
            categoryId: category.id, restaurantId: rid,
            venuePrices: {
              create: createdSections.map(s => ({
                venueId: s.id,
                price: item.price,
                isActive: true,
                restaurantId: rid,
              }))
            }
          }
        })));
      }
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
            pricesIncludeGst: data.taxConfig?.pricesIncludeGst ?? false,
            gstCategory: data.taxConfig?.gstCategory ?? 'NON_AC',
            serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
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
            data: {
              name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD',
              categoryId: category.id, restaurantId: outlet.id,
              venuePrices: {
                create: outletSections.map(s => ({
                  venueId: s.id,
                  price: item.price,
                  isActive: true,
                  restaurantId: outlet.id,
                }))
              }
            }
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
    // Cleanup: delete all created users and restaurants (cascades all children)
    for (const id of createdUserIds) {
      try { await prisma.user.delete({ where: { id } }); } catch {}
    }
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

// POST /api/onboard/payment/razorpay-webhook — Razorpay webhook for payment captured events
router.post('/payment/razorpay-webhook', async (req: Request, res: Response) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      console.error('[Razorpay Webhook] Missing webhook secret');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    const signature = req.headers['x-razorpay-signature'] as string;
    const body = req.body as Buffer;
    if (!signature || !body) {
      return res.status(400).json({ error: 'Missing signature or body' });
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    if (expected !== signature) {
      console.warn('[Razorpay Webhook] Signature mismatch');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(body.toString());
    const event = payload.event;
    const orderId = payload.payload?.payment?.entity?.order_id;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing order_id' });
    }

    // Only process successful payment events
    if (event !== 'payment.captured' && event !== 'payment.failed') {
      return res.status(200).json({ message: 'Event ignored' });
    }

    const payment = await prisma.onboardingPayment.findFirst({
      where: { gatewayOrderId: orderId, status: 'CREATED' }
    });

    if (!payment) {
      return res.status(200).json({ message: 'Payment already processed or not found' });
    }

    if (event === 'payment.captured') {
      await prisma.onboardingPayment.update({
        where: { id: payment.id },
        data: { status: 'SUCCESS', gatewayPaymentId: payload.payload?.payment?.entity?.id }
      });

      // If restaurant already created (onboarding completed), activate it
      if (payment.restaurantId) {
        await prisma.restaurant.update({
          where: { id: payment.restaurantId },
          data: { billingStatus: 'active' }
        });
      }

      return res.status(200).json({ message: 'Payment captured and activated' });
    }

    // payment.failed
    await prisma.onboardingPayment.update({
      where: { id: payment.id },
      data: { status: 'FAILED' }
    });

    return res.status(200).json({ message: 'Payment failed recorded' });
  } catch (error) {
    console.error('[Razorpay Webhook] Error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

export { router as onboardRouter };

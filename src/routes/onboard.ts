import { Router, Request, Response } from 'express';
import logger from "../lib/logger";
import crypto from 'crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { hashPassword, signToken } from '../lib/auth';
import { basePrisma as prisma } from '../lib/prisma';
import { sendWelcomeEmail } from '../lib/email';
import { computePlanPrice } from '../config/pricing';
import { getPaymentGateway, MockPaymentGateway } from '../services/paymentGateway';
import { computeEnabledModules } from '../lib/moduleDefaults';
import { checkVerificationProof } from '../lib/verificationToken';
import { invalidateTenantContextCache } from '../lib/tenantContext';
import { acquireLock, releaseLock } from '../lib/redisLock';

const router = Router();

async function allocateRestaurantCode(): Promise<string> {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let attempts = 0; attempts < 100; attempts++) {
    const randomBytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(randomBytes[i] % chars.length);
    }
    const existing = await prisma.outlet.findUnique({ where: { restaurantCode: code } });
    if (!existing) return code;
  }
  throw new Error('Failed to allocate unique restaurantCode after 100 attempts');
}

const VenueSchema = z.object({
  name: z.string().min(1),
  venueType: z.enum(['DINE_IN', 'BAR', 'CAFE', 'TAKEAWAY', 'DELIVERY', 'BANQUET', 'CONFERENCE', 'PDR', 'ROOM_SERVICE']).default('DINE_IN'),
  floors: z.array(z.object({
    name: z.string().min(1),
    sections: z.array(z.object({
      name: z.string().min(1),
      tables: z.array(z.object({
        number: z.number().int().positive(),
        capacity: z.number().int().default(4),
      })).optional().default([]),
    })).min(1),
  })).optional().default([]),
  // For non-DINE_IN venues without floors: a single implicit section
  tableCount: z.number().int().min(0).default(0),
  priceProfileName: z.string().optional(),
  taxProfileName: z.string().optional(),
  // Legacy compat: if frontend sends sections/tables flat
  sections: z.array(z.object({ name: z.string().min(1) })).optional().default([]),
  tables: z.array(z.object({
    number: z.number().int().positive(),
    capacity: z.number().int().default(4),
    sectionIndex: z.number().int().min(0),
  })).optional().default([]),
});

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
      taxRate: z.string().optional(),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true),
        taxRate: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        variants: z.array(z.object({
          name: z.string().min(1),
          price: z.number().positive(),
          isDefault: z.boolean().default(false)
        })).optional()
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
    receiptFooter: z.string().optional(),
    fssai: z.string().optional(),
    themePrimary: z.string().optional(),
    logoUrl: z.string().optional(),
    billPrefix: z.string().optional(),
    startingBillNumber: z.number().optional()
  }).optional(),
  taxConfig: z.object({
    gstRegistered: z.boolean().default(true),
    gstCategory: z.enum(['NON_AC', 'AC', 'TAKEAWAY']).optional(),
    gstRate: z.number().min(0).max(100).optional().nullable(),
    pricesIncludeGst: z.boolean().default(false),
    serviceChargePercent: z.number().min(0).max(20).default(0),
    packagingCharge: z.number().default(0)
  }).optional(),
  owner: z.object({
    name: z.string().min(2),
    email: z.string().email(),
    phone: z.string().min(10),
    password: z.string().min(8),
    termsAccepted: z.literal(true, { message: 'You must accept the Terms of Service' }),
    marketingConsent: z.boolean().optional()
  }),
  captains: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/),
    venueName: z.string().optional(),
  })).optional().default([]),
  cashiers: z.array(z.object({
    name: z.string().min(2),
    pin: z.string().length(4).regex(/^\d{4}$/),
    venueName: z.string().optional(),
  })).min(1),
  sections: z.array(z.object({
    name: z.string().min(1)
  })).optional().default([]),
  tables: z.array(z.object({
    number: z.number().int().positive(),
    capacity: z.number().int().default(4),
    sectionIndex: z.number().int().min(0)
  })).optional().default([]),
  venues: z.array(VenueSchema).optional().default([]),
  menuSharing: z.enum(['SHARED', 'PER_VENUE']).default('SHARED'),
  pricingMode: z.enum(['UNIFIED', 'PER_VENUE']).default('UNIFIED'),
  menu: z.object({
    categories: z.array(z.object({
      name: z.string().min(1),
      taxRate: z.string().optional(),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true),
        taxRate: z.string().optional(),
        platforms: z.array(z.string()).optional(),
        menuType: z.enum(['FOOD', 'LIQUOR']).optional(),
        unit: z.string().optional(),
        isAvailable: z.boolean().optional(),
        venuePrices: z.record(z.string(), z.number()).optional(),
        variants: z.array(z.object({
          name: z.string().min(1),
          price: z.number().positive(),
          isDefault: z.boolean().default(false)
        })).optional()
      })).min(1)
    })).min(1)
  }),
  barMenu: z.object({
    categories: z.array(z.object({
      name: z.string().min(1),
      items: z.array(z.object({
        name: z.string().min(1),
        price: z.number().positive(),
        isVeg: z.boolean().default(true),
        availableSizes: z.array(z.string()).optional(),
        menuType: z.enum(['FOOD', 'LIQUOR']).optional(),
        unit: z.string().optional(),
        isAvailable: z.boolean().optional(),
        venuePrices: z.record(z.string(), z.number()).optional(),
        variants: z.array(z.object({
          name: z.string().min(1),
          price: z.number().positive(),
          isDefault: z.boolean().default(false)
        })).optional()
      })).min(1)
    })).min(1)
  }).optional(),
  priceProfiles: z.array(z.object({
    name: z.string().min(1),
    isDefault: z.boolean().default(false),
  })).optional().default([]),
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
  emailVerificationProof: z.string().optional(),
  phoneVerificationProof: z.string().min(1, 'Phone must be verified')
});

// GET /api/onboard/check-slug?slug=xxx — public, no auth
router.get('/check-slug', async (req, res) => {
  try {
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!slug || slug.length < 2) {
      return res.status(400).json({ error: 'slug must be at least 2 characters' });
    }
    const existing = await prisma.outlet.findUnique({ where: { slug } });
    return res.json({ available: !existing, slug });
  } catch (error) {
    logger.error({ err: error }, '[Onboard Check Slug] Error:');
    return res.status(500).json({ error: 'Internal server error' });
  }
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
  logger.info({ plan, numberOfOutlets, sessionId }, '[Onboard Payment Mock] Request received');
  try {
    if (!plan || !numberOfOutlets || !sessionId) {
      return res.status(400).json({ error: 'plan, numberOfOutlets, sessionId are required' });
    }
    const quote = computePlanPrice(plan, Number(numberOfOutlets));
    const gateway = new MockPaymentGateway();
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

    logger.info({ paymentId: payment.id, amount: quote.totalMonthly }, `[Onboard Payment Mock] Success in ${Date.now() - start}ms`);
    if (!verify.success) return res.status(402).json({ error: 'Payment failed', reason: verify.reason });
    return res.status(201).json({ paymentReference: payment.id, amount: quote.totalMonthly, currency: 'INR' });
  } catch (err: any) {
    logger.error({ err }, `[Onboard Payment Mock] Error after ${Date.now() - start}ms`);
    return res.status(500).json({ error: 'Payment processing failed' });
  }
});

// GET /api/onboard/payment/config — returns the active payment gateway and keyId
router.get('/payment/config', (_req, res) => {
  const isRazorpay = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  return res.json({
    gateway: isRazorpay ? 'RAZORPAY' : 'MOCK',
    keyId: isRazorpay ? process.env.RAZORPAY_KEY_ID : null,
  });
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
    logger.error({ err }, '[Onboard Payment Initiate] Error:');
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
    logger.error({ err }, '[Onboard Payment Verify] Error:');
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

const onboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req: any) => req.body?.owner?.email || req.body?.sessionId || req.ip,
  message: { error: 'Too many onboarding attempts, please wait a minute' },
});

router.post('/', onboardLimiter, async (req: Request, res: Response) => {
  // Track IDs for cleanup on partial failure
  const createdRestaurantIds: string[] = [];
  const createdUserIds: string[] = [];

  let lockKey: string | null = null;

  try {
    const data = OnboardSchema.parse(req.body);

    // Verification proof guards — prevent someone from verifying one email/phone and submitting different values
    // Email verification is optional during onboarding; phone is required
    if (data.emailVerificationProof) {
      const emailOk = checkVerificationProof(data.emailVerificationProof, 'email', data.owner.email.toLowerCase(), data.sessionId);
      if (!emailOk) {
        logger.error({ email: data.owner.email.toLowerCase(), sessionId: data.sessionId }, '[Onboard] Email verification failed');
        return res.status(400).json({ error: 'Email verification invalid or expired — please re-verify' });
      }
    }

    const normalizedPhone = data.owner.phone.startsWith('+') ? data.owner.phone : '+91' + data.owner.phone.replace(/\D/g, '').slice(-10);
    const phoneOk = checkVerificationProof(data.phoneVerificationProof, 'phone', normalizedPhone, data.sessionId);
    if (!phoneOk) {
      logger.error({ phone: normalizedPhone, sessionId: data.sessionId }, '[Onboard] Phone verification failed');
      return res.status(400).json({ error: 'Phone verification invalid or expired — please re-verify' });
    }

    // Payment verification guard — before any restaurant creation
    const payment = await prisma.onboardingPayment.findUnique({ where: { id: data.paymentReference } });
    if (!payment || payment.status !== 'SUCCESS' || payment.plan !== data.plan || payment.numberOfOutlets !== data.restaurant.outletCount) {
      return res.status(402).json({ error: 'Valid payment is required before completing onboarding' });
    }

    // Idempotency guard — if this payment already has a linked restaurant, onboarding was already completed
    if (payment.restaurantId) {
      const existingOutlet = await prisma.outlet.findUnique({ where: { id: payment.restaurantId }, select: { restaurantCode: true } });
      return res.status(409).json({
        error: 'Onboarding already completed for this payment. Please log in with your credentials.',
        restaurantCode: existingOutlet?.restaurantCode,
      });
    }

    // Redis lock — prevents concurrent duplicate submissions with the same paymentReference
    lockKey = `onboard:${data.paymentReference}`;
    const locked = await acquireLock(lockKey, 120);
    if (!locked) {
      return res.status(429).json({ error: 'Onboarding is already in progress for this payment. Please wait a moment.' });
    }

    // Pre-check: if email exists, only allow restart if the linked restaurant has no live data
    const existingUser = await prisma.user.findFirst({ where: { email: data.owner.email } });
    if (existingUser) {
      if (existingUser.outletId) {
        const [orderCount, txnCount] = await Promise.all([
          prisma.order.count({ where: { restaurantId: existingUser.outletId } }),
          prisma.transaction.count({ where: { restaurantId: existingUser.outletId } }),
        ]);
        if (orderCount > 0 || txnCount > 0) {
          return res.status(409).json({
            error: 'This email already manages a live restaurant with orders or transactions. Use a different email or contact support.',
          });
        }
        await prisma.user.deleteMany({ where: { outletId: existingUser.outletId } });
        await prisma.outlet.delete({ where: { id: existingUser.outletId } }).catch(() => {});
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

    // Build features JSON: taxConfig + deliveryPlatforms + branding extras
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
    if (data.branding?.receiptFooter) features.receiptFooter = data.branding.receiptFooter;
    if (data.branding?.billPrefix) features.billPrefix = data.branding.billPrefix;
    if (data.branding?.startingBillNumber) features.startingBillNumber = data.branding.startingBillNumber;

    // 2. Create Organization first (billing root)
    const org = await prisma.organization.create({
      data: {
        name: data.restaurant.name,
        plan: data.plan,
        billingStatus: 'active',
        paymentStatus: payment.gateway === 'RAZORPAY' ? 'PAID' : 'MOCK_PAID',
        features: Object.keys(features).length > 0 ? features : undefined,
        enabledModules,
      }
    });

    // 2b. Create main Outlet linked to Organization
    const restaurant = await prisma.outlet.create({
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
        gstRate: data.taxConfig?.gstRate ?? null,
        gstRegistered: data.taxConfig?.gstRegistered ?? true,
        serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
        slug,
        restaurantCode,
        onboardingCompletedAt: new Date(),
        organizationId: org.id,
      }
    });
    createdRestaurantIds.push(restaurant.id);
    const rid = restaurant.id;
    (restaurant as any).restaurantCode = restaurantCode;

    // 3. Owner
    const owner = await prisma.user.create({
      data: { name: data.owner.name, email: data.owner.email, passwordHash: ownerHash, role: 'OWNER', outletId: rid }
    });
    createdUserIds.push(owner.id);

    // 3a. Owner OutletAccess (required for switch-outlet and multi-outlet auth)
    await prisma.outletAccess.create({
      data: { userId: owner.id, outletId: rid, role: 'OWNER' }
    });

    // 4. Captains + Cashiers (parallel batches)
    const createdStaff = await Promise.all([
      ...data.captains.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: captainHashes[i], role: 'CAPTAIN', outletId: rid }
      })),
      ...data.cashiers.map((c, i) => prisma.user.create({
        data: { name: c.name, pin: cashierHashes[i], role: 'CASHIER', outletId: rid }
      }))
    ]);
    createdStaff.forEach(u => createdUserIds.push(u.id));

    // 5. Main outlet: Venues + Floors + Sections + Tables + Menu
    const hasNewVenueStructure = data.venues && data.venues.length > 0;
    const venueMap = new Map<string, string>();
    const priceProfileMap = new Map<string, string>();
    const allMenuItems: Array<{ id: string; basePrice: number }> = [];
    let createdSections: Array<{ id: string }> = [];

    if (hasNewVenueStructure) {
      // 5a. Create default TaxProfile
      const defaultTaxProfile = await prisma.taxProfile.create({
        data: {
          restaurantId: rid,
          name: 'Default',
          gstCategory: data.taxConfig?.gstCategory ?? 'NON_AC',
          gstRate: data.taxConfig?.gstRate ?? null,
          gstRegistered: data.taxConfig?.gstRegistered ?? true,
          serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
          isDefault: true,
        },
      });

      // 5b. Create PriceProfiles
      for (const pp of data.priceProfiles || []) {
        const created = await prisma.priceProfile.create({
          data: { restaurantId: rid, name: pp.name, isDefault: pp.isDefault ?? false },
        });
        priceProfileMap.set(pp.name, created.id);
      }
      if ((data.priceProfiles || []).length === 0) {
        const defaultPP = await prisma.priceProfile.create({
          data: { restaurantId: rid, name: 'Default', isDefault: true },
        });
        priceProfileMap.set('Default', defaultPP.id);
      }

      // 5c. Create Venues in parallel
      const venueCreations = data.venues!.map(v => {
        const priceProfileId = v.priceProfileName
          ? priceProfileMap.get(v.priceProfileName)
          : Array.from(priceProfileMap.values())[0];
        return prisma.venue.create({
          data: {
            restaurantId: rid,
            name: v.name,
            venueType: v.venueType,
            priceProfileId: priceProfileId || null,
            taxProfileId: defaultTaxProfile.id,
          },
        });
      });
      const createdVenues = await Promise.all(venueCreations);
      data.venues!.forEach((v, i) => venueMap.set(v.name, createdVenues[i].id));

      // Collect all floors and sections to create
      const floorInputs: Array<{ venueId: string; restaurantId: string; name: string; sections: any[] }> = [];
      const sectionInputs: Array<{ name: string; restaurantId: string; venueId: string; floorId?: string; tables: any[] }> = [];

      for (const venueData of data.venues!) {
        const venueId = venueMap.get(venueData.name)!;
        if (venueData.floors && venueData.floors.length > 0) {
          for (const floorData of venueData.floors) {
            floorInputs.push({ venueId, restaurantId: rid, name: floorData.name, sections: floorData.sections });
          }
        } else if (venueData.tableCount > 0) {
          sectionInputs.push({
            name: venueData.name,
            restaurantId: rid,
            venueId,
            tables: Array.from({ length: venueData.tableCount }, (_, i) => ({ number: i + 1, capacity: 4 })),
          });
        } else {
          sectionInputs.push({
            name: venueData.name,
            restaurantId: rid,
            venueId,
            tables: [{ number: 999, capacity: 0 }],
          });
        }
      }

      // Create all floors in parallel
      const createdFloors = await Promise.all(
        floorInputs.map(f => prisma.floor.create({ data: { venueId: f.venueId, restaurantId: f.restaurantId, name: f.name } }))
      );
      const floorIdMap = new Map<string, string>();
      createdFloors.forEach((f, i) => {
        floorIdMap.set(`${floorInputs[i].venueId}-${floorInputs[i].name}`, f.id);
        for (const sectionData of floorInputs[i].sections) {
          sectionInputs.push({
            name: sectionData.name,
            restaurantId: rid,
            venueId: floorInputs[i].venueId,
            floorId: f.id,
            tables: sectionData.tables || [],
          });
        }
      });

      // Create all sections in parallel
      const createdSectionsList = await Promise.all(
        sectionInputs.map(s => prisma.section.create({ data: { name: s.name, restaurantId: s.restaurantId, venueId: s.venueId, floorId: s.floorId } }))
      );
      createdSections.push(...createdSectionsList);

      // Create all tables with createMany
      const allTables: Array<{ number: number; capacity: number; sectionId: string; restaurantId: string }> = [];
      for (let i = 0; i < sectionInputs.length; i++) {
        const sectionId = createdSectionsList[i].id;
        for (const t of sectionInputs[i].tables) {
          allTables.push({ number: t.number, capacity: t.capacity, sectionId, restaurantId: rid });
        }
      }
      if (allTables.length > 0) {
        await prisma.table.createMany({ data: allTables });
      }

      // 5d. Create all menu categories in parallel
      const regularCategories = await Promise.all(
        data.menu.categories.map(cat => prisma.category.create({ data: { name: cat.name, restaurantId: rid } }))
      );
      const barCategories = data.barMenu?.categories
        ? await Promise.all(data.barMenu.categories.map(cat => prisma.category.create({ data: { name: cat.name, restaurantId: rid } })))
        : [];

      // Create all menu items in parallel
      const regularItems = await Promise.all(
        data.menu.categories.flatMap((cat, ci) =>
          cat.items.map(item => prisma.menuItem.create({
            data: {
              name: item.name,
              basePrice: item.price,
              isVeg: item.isVeg,
              isAvailable: item.isAvailable ?? true,
              menuType: (item.menuType as any) || 'FOOD',
              ...(item.unit ? { unit: item.unit.substring(0, 20) } : {}),
              categoryId: regularCategories[ci].id, restaurantId: rid,
              variants: {
                create: item.variants
                  ? item.variants.map((v, i) => ({ name: v.name, price: v.price, isDefault: i === 0, restaurantId: rid }))
                  : [{ name: "Regular", price: item.price, isDefault: true, restaurantId: rid }]
              },
            },
          }))
        )
      );
      const barItems = data.barMenu?.categories
        ? await Promise.all(
            data.barMenu.categories.flatMap((cat, ci) =>
              cat.items.map(item => prisma.menuItem.create({
                data: {
                  name: item.name,
                  basePrice: item.price,
                  isVeg: item.isVeg,
                  isAvailable: item.isAvailable ?? true,
                  menuType: (item.menuType as any) || 'LIQUOR',
                  ...(item.unit ? { unit: item.unit.substring(0, 20) } : {}),
                  categoryId: barCategories[ci].id, restaurantId: rid,
                  variants: {
                    create: item.variants
                      ? item.variants.map((v, i) => ({ name: v.name, price: v.price, isDefault: i === 0, restaurantId: rid }))
                      : [{ name: "Regular", price: item.price, isDefault: true, restaurantId: rid }]
                  },
                },
              }))
            )
          )
        : [];

      // Track which items have per-venue pricing (from rate card upload)
      const allFlatItems = [
        ...data.menu.categories.flatMap((cat, ci) => cat.items.map(item => ({ item, categoryId: regularCategories[ci].id }))),
        ...(data.barMenu?.categories || []).flatMap((cat, ci) => cat.items.map(item => ({ item, categoryId: barCategories[ci]?.id }))),
      ];

      allMenuItems.push(
        ...regularItems.map(i => ({ id: i.id, basePrice: Number(i.basePrice) })),
        ...barItems.map(i => ({ id: i.id, basePrice: Number(i.basePrice) }))
      );

      // Build a map of menuItemId → venuePrices for rate card items
      const menuItemVenuePrices = new Map<string, Record<string, number>>();
      let itemIdx = 0;
      for (const { item } of allFlatItems) {
        const menuItem = allMenuItems[itemIdx];
        itemIdx++;
        if (item.venuePrices && Object.keys(item.venuePrices).length > 0) {
          menuItemVenuePrices.set(menuItem.id, item.venuePrices);
        }
      }

      // 5e. Seed PriceProfileItem + VenuePrice with createMany
      const allPriceProfileIds = Array.from(priceProfileMap.values());
      const priceProfileItems: Array<{ priceProfileId: string; menuItemId: string; price: number; restaurantId: string }> = [];
      for (const menuItem of allMenuItems) {
        for (const ppId of allPriceProfileIds) {
          priceProfileItems.push({ priceProfileId: ppId, menuItemId: menuItem.id, price: menuItem.basePrice, restaurantId: rid });
        }
      }
      if (priceProfileItems.length > 0) {
        await prisma.priceProfileItem.createMany({ data: priceProfileItems });
      }

      const venuePrices: Array<{ venueId: string; menuItemId: string; price: number; isActive: boolean; restaurantId: string }> = [];
      // Build normalized venue name → venueId map for fuzzy matching with rate card
      const normalizeForMatch = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const venueAliases: Record<string, string> = { "pdr": "privatediningroom", "parcel": "takeaway", "gobox": "gobox" };
      const normalizedVenueMap = new Map<string, string>();
      for (const [vName, vId] of venueMap) {
        const norm = normalizeForMatch(vName);
        normalizedVenueMap.set(norm, vId);
        // Also add alias-transformed key
        const aliased = venueAliases[norm];
        if (aliased) normalizedVenueMap.set(aliased, vId);
      }

      for (const menuItem of allMenuItems) {
        const itemVP = menuItemVenuePrices.get(menuItem.id);
        for (const [venueName, venueId] of venueMap) {
          if (itemVP) {
            // Rate card item: try exact venue name match first, then fuzzy
            let price = itemVP[venueName];
            if (price === undefined) {
              // Try normalized match
              const normVenue = normalizeForMatch(venueName);
              const aliasedVenue = venueAliases[normVenue] || normVenue;
              for (const [vpName, vpPrice] of Object.entries(itemVP)) {
                const normVP = normalizeForMatch(vpName);
                const aliasedVP = venueAliases[normVP] || normVP;
                if (normVP === normVenue || aliasedVP === aliasedVenue ||
                    normVP.includes(normVenue) || normVenue.includes(normVP) ||
                    aliasedVP.includes(aliasedVenue) || aliasedVenue.includes(aliasedVP)) {
                  price = vpPrice;
                  break;
                }
              }
            }
            if (price !== undefined && price > 0) {
              venuePrices.push({ venueId, menuItemId: menuItem.id, price, isActive: true, restaurantId: rid });
            }
          } else {
            // Standard item: seed all venues with base price
            venuePrices.push({ venueId, menuItemId: menuItem.id, price: menuItem.basePrice, isActive: true, restaurantId: rid });
          }
        }
      }
      if (venuePrices.length > 0) {
        await prisma.venuePrice.createMany({ data: venuePrices });
      }
    } else {
      // Legacy path
      let sectionsToCreate = data.sections;
      if (sectionsToCreate.length === 0) {
        if (data.restaurant.restaurantType === 'CAFE') {
          sectionsToCreate = [{ name: 'Counter' }];
        } else if (data.restaurant.restaurantType === 'CLOUD_KITCHEN') {
          sectionsToCreate = [{ name: 'Kitchen' }];
        } else {
          sectionsToCreate = [{ name: 'Main Hall' }];
        }
      }
      createdSections = await Promise.all(
        sectionsToCreate.map(s => prisma.section.create({ data: { name: s.name, restaurantId: rid } }))
      );
      let tablesToCreate = data.tables;
      if (tablesToCreate.length === 0 && createdSections.length > 0) {
        tablesToCreate = [{ number: 1, capacity: 0, sectionIndex: 0 }];
      }
      await Promise.all(
        tablesToCreate.map(t => prisma.table.create({
          data: { number: t.number, capacity: t.capacity, sectionId: createdSections[t.sectionIndex].id, restaurantId: rid }
        }))
      );
      const legacyCategories = await Promise.all(
        data.menu.categories.map(cat => prisma.category.create({ data: { name: cat.name, restaurantId: rid } }))
      );
      await Promise.all(
        data.menu.categories.flatMap((cat, ci) =>
          cat.items.map(item => prisma.menuItem.create({
            data: {
              name: item.name, basePrice: item.price, isVeg: item.isVeg,
              isAvailable: item.isAvailable ?? true,
              menuType: (item.menuType as any) || 'FOOD',
              ...(item.unit ? { unit: item.unit.substring(0, 20) } : {}),
              categoryId: legacyCategories[ci].id, restaurantId: rid,
              venuePrices: { create: createdSections.map(s => ({ venueId: s.id, price: item.price, isActive: true, restaurantId: rid })) },
              variants: {
                create: item.variants
                  ? item.variants.map((v, i) => ({ name: v.name, price: v.price, isDefault: i === 0, restaurantId: rid }))
                  : [{ name: "Regular", price: item.price, isDefault: true, restaurantId: rid }]
              },
            }
          }))
        )
      );
      if (data.barMenu?.categories) {
        const barLegacyCategories = await Promise.all(
          data.barMenu.categories.map(cat => prisma.category.create({ data: { name: cat.name, restaurantId: rid } }))
        );
        await Promise.all(
          data.barMenu.categories.flatMap((cat, ci) =>
            cat.items.map(item => prisma.menuItem.create({
              data: {
                name: item.name, basePrice: item.price, isVeg: item.isVeg,
                isAvailable: item.isAvailable ?? true,
                menuType: (item.menuType as any) || 'LIQUOR',
                ...(item.unit ? { unit: item.unit.substring(0, 20) } : {}),
                categoryId: barLegacyCategories[ci].id, restaurantId: rid,
                venuePrices: { create: createdSections.map(s => ({ venueId: s.id, price: item.price, isActive: true, restaurantId: rid })) },
                variants: {
                  create: item.variants
                    ? item.variants.map((v, i) => ({ name: v.name, price: v.price, isDefault: i === 0, restaurantId: rid }))
                    : [{ name: "Regular", price: item.price, isDefault: true, restaurantId: rid }]
                },
              }
            }))
          )
        );
      }
    }

    // 5f. Staff venue scoping — resolve venueName to venueId for new tenants
    if (hasNewVenueStructure) {
      for (const captain of data.captains) {
        if (captain.venueName && venueMap.has(captain.venueName)) {
          await prisma.user.updateMany({
            where: { outletId: rid, name: captain.name, role: 'CAPTAIN' },
            data: { venueId: venueMap.get(captain.venueName) },
          });
        }
      }
      for (const cashier of data.cashiers) {
        if (cashier.venueName && venueMap.has(cashier.venueName)) {
          await prisma.user.updateMany({
            where: { outletId: rid, name: cashier.name, role: 'CASHIER' },
            data: { venueId: venueMap.get(cashier.venueName) },
          });
        }
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
        const outlet = await prisma.outlet.create({
          data: {
            name: outletData.name,
            slug: outletSlug,
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
            gstRate: data.taxConfig?.gstRate ?? null,
            gstRegistered: data.taxConfig?.gstRegistered ?? true,
            serviceChargePercent: data.taxConfig?.serviceChargePercent ?? 0,
            organizationId: org.id,
          }
        });
        createdRestaurantIds.push(outlet.id);
        outletIds.push(outlet.id);

        // Owner access to additional outlet
        await prisma.outletAccess.create({
          data: { userId: owner.id, outletId: outlet.id, role: 'OWNER' }
        });

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
        const outletCategories = await Promise.all(
          outletData.menu.categories.map(cat => prisma.category.create({ data: { name: cat.name, restaurantId: outlet.id } }))
        );
        await Promise.all(
          outletData.menu.categories.flatMap((cat, ci) =>
            cat.items.map(item => prisma.menuItem.create({
              data: {
                name: item.name, basePrice: item.price, isVeg: item.isVeg, isAvailable: true, menuType: 'FOOD',
                categoryId: outletCategories[ci].id, restaurantId: outlet.id,
                venuePrices: {
                  create: outletSections.map(s => ({
                    venueId: s.id,
                    price: item.price,
                    isActive: true,
                    restaurantId: outlet.id,
                  }))
                },
                variants: {
                  create: item.variants
                    ? item.variants.map((v, i) => ({ name: v.name, price: v.price, isDefault: i === 0, restaurantId: outlet.id }))
                    : [{ name: "Regular", price: item.price, isDefault: true, restaurantId: outlet.id }]
                },
              }
            }))
          )
        );

        // DailyCounter for outlet
        await prisma.dailyCounter.create({ data: { restaurantId: outlet.id, counterDate: today } });
      }
    }

    // Invalidate tenant context cache for the parent outlet since child outlets changed the hierarchy
    if (outletIds.length > 1) {
      await invalidateTenantContextCache(rid);
    }

    // Link payment record to restaurant
    await prisma.onboardingPayment.update({ where: { id: data.paymentReference }, data: { restaurantId: restaurant.id } });

    // Fire-and-forget welcome email only after everything succeeded
    const staffPins = [
      ...data.captains.map(c => ({ name: c.name, pin: c.pin, role: 'Captain' })),
      ...data.cashiers.map(c => ({ name: c.name, pin: c.pin, role: 'Cashier' })),
    ];
    sendWelcomeEmail(owner.email!, owner.name, restaurant.name, restaurantCode, staffPins).catch(() => {});

    logger.info(`[Onboard] Restaurant created: ${slug} (${restaurantCode}) with ${outletIds.length} outlet(s)`);

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
      try { await prisma.outlet.delete({ where: { id } }); } catch {}
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.issues });
    }
    logger.error({ err: error }, '[Onboard] Error:');
    return res.status(500).json({ error: error?.message || String(error), detail: error?.stack || '' });
  } finally {
    if (lockKey) await releaseLock(lockKey);
  }
});

// POST /api/onboard/payment/razorpay-webhook — Razorpay webhook for payment captured events
router.post('/payment/razorpay-webhook', async (req: Request, res: Response) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      logger.error('[Razorpay Webhook] Missing webhook secret');
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

    if (!signature || typeof signature !== 'string') {
      return res.status(400).json({ error: 'Missing signature' });
    }

    try {
      const expectedBuf = Buffer.from(expected, 'hex');
      const sigBuf = Buffer.from(signature, 'hex');
      if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
        logger.warn('[Razorpay Webhook] Signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    } catch {
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
        const outlet = await prisma.outlet.findUnique({ where: { id: payment.restaurantId }, select: { organizationId: true } });
        if (outlet?.organizationId) {
          await prisma.organization.update({
            where: { id: outlet.organizationId },
            data: { billingStatus: 'active' }
          });
        }
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
    logger.error({ err: error }, '[Razorpay Webhook] Error:');
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// POST /api/onboard/resend-welcome — resend the welcome email for an already-onboarded restaurant
router.post('/resend-welcome', async (req: Request, res: Response) => {
  try {
    const { email, restaurantCode } = req.body || {};
    if (!email || !restaurantCode) {
      return res.status(400).json({ error: 'email and restaurantCode are required' });
    }

    const outlet = await prisma.outlet.findUnique({ where: { restaurantCode } });
    if (!outlet) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const owner = await prisma.user.findFirst({ where: { outletId: outlet.id, role: 'OWNER' } });
    if (!owner || !owner.email || owner.email.toLowerCase() !== email.toLowerCase()) {
      return res.status(404).json({ error: 'No matching owner found for this email and restaurant code' });
    }

    await sendWelcomeEmail(owner.email, owner.name, outlet.name, restaurantCode);
    logger.info({ email: owner.email, restaurantCode }, '[Onboard Resend Welcome] Email sent');
    return res.json({ sent: true });
  } catch (error: any) {
    logger.error({ err: error }, '[Onboard Resend Welcome] Error:');
    return res.status(500).json({ error: 'Failed to resend welcome email' });
  }
});

export { router as onboardRouter };

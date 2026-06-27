import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { AuthRequest, authenticate, optionalAuth, invalidateUserActiveCache } from '../middleware/auth';
import { withTenantContext } from '../middleware/tenantContext';
import { z } from 'zod';
import { hashPassword, comparePassword, signToken, verifyToken, requireAuth } from '../lib/auth';
import { requireRole } from '../middleware/auth';
import prisma from '../lib/prisma';
import { sendPasswordResetEmail } from '../lib/email';
import { cacheGet, cacheSet, cacheDelete } from '../lib/cache';
import logger from '../lib/logger';

const router = Router();
const PIN_LOCKOUT_ATTEMPTS = 5;
const PIN_LOCKOUT_TTL_SECONDS = 15 * 60;

// ── Zod schemas for input validation ───────────────────────────────────────
const loginSchema = z.object({
  email: z.string().email().min(1),
  password: z.string().min(1),
  restaurantCode: z.string().min(1),
});

const captainLoginSchema = z.object({
  restaurantId: z.string().optional(),
  restaurantCode: z.string().optional(),
  userId: z.string().min(1),
  pin: z.string().min(4).max(6),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
  restaurantCode: z.string().min(1),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// POST /api/auth/login — restaurantCode + email + password → JWT (for OWNER/ADMIN)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { email, password, restaurantCode } = parsed.data;

    const code = restaurantCode.trim().toUpperCase();
    const emailNormalized = email.trim().toLowerCase();
    logger.info(`[Auth Login] Attempt: code=${code}`);

    let restaurant;
    try {
      restaurant = await prisma.outlet.findUnique({
        where: { restaurantCode: code }
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[Auth Login] DB error fetching outlet');
      return res.status(500).json({ error: 'Database error fetching outlet' });
    }

    if (!restaurant) {
      logger.info(`[Auth Login] Restaurant not found: ${code}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!restaurant.isActive) {
      logger.info(`[Auth Login] Restaurant inactive: ${code}`);
      return res.status(403).json({ error: 'Restaurant account is inactive' });
    }

    let user;
    try {
      user = await prisma.user.findFirst({
        where: { email: emailNormalized, outletId: restaurant.id },
        include: { outlet: true }
      });
    } catch (dbErr) {
      logger.error({ err: dbErr }, '[Auth Login] DB error fetching user');
      return res.status(500).json({ error: 'Database error fetching user' });
    }

    if (!user) {
      logger.info(`[Auth Login] User not found`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.passwordHash) {
      logger.info(`[Auth Login] User has no passwordHash`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let isValid: boolean;
    try {
      isValid = await comparePassword(password, user.passwordHash);
    } catch (err) {
      logger.error({ err }, '[Auth Login] Password comparison error');
      return res.status(500).json({ error: 'Password check failed' });
    }
    logger.info(`[Auth Login] Password comparison: role=${user.role}`);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      logger.info(`[Auth Login] User inactive: role=${user.role}`);
      return res.status(403).json({ error: 'Account is inactive' });
    }

    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      logger.info(`[Auth Login] Role rejected: role=${user.role}`);
      return res.status(403).json({ error: 'Only owners and admins can login with email/password' });
    }

    logger.info(`[Auth Login] Success: role=${user.role}, restaurant=${restaurant.id}`);

    let token: string;

    const outletAccess = await prisma.outletAccess.findMany({
      where: { userId: user.id },
      include: { outlet: { select: { id: true, name: true, restaurantCode: true } } }
    });

    if (outletAccess.length > 1) {
      return res.json({
        accessibleOutlets: outletAccess.map(oa => ({
          id: oa.outlet.id,
          name: oa.outlet.name,
          restaurantCode: oa.outlet.restaurantCode,
        }))
      });
    }

    try {
      token = signToken({
        userId: user.id,
        email: user.email!,
        role: user.role,
        restaurantId: user.outletId,
        restaurantCode: restaurant.restaurantCode,
        slug: restaurant.slug,
        organizationId: restaurant.organizationId
      });
    } catch (jwtErr) {
      logger.error({ err: jwtErr }, '[Auth Login] JWT signing failed');
      return res.status(500).json({ error: 'Failed to create session token' });
    }

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurantId: user.outletId,
        restaurantCode: restaurant.restaurantCode
      },
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        restaurantCode: restaurant.restaurantCode,
        logoUrl: restaurant.logoUrl ?? null,
        receiptHeader: restaurant.receiptHeader ?? null,
        receiptSubHeader: restaurant.receiptSubHeader ?? null,
        themePrimary: restaurant.themePrimary ?? null,
        printerConfig: restaurant.printerConfig ?? null,
        barUnitMl: restaurant.barUnitMl,
        fullBottleMl: restaurant.fullBottleMl,
        gstCategory: restaurant.gstCategory ?? 'NON_AC',
        gstRate: restaurant.gstRate ?? null,
        gstRegistered: restaurant.gstRegistered ?? true,
        pricesIncludeGst: restaurant.pricesIncludeGst ?? false,
        restaurantType: restaurant.restaurantType ?? 'DINE_IN',
        outletCount: restaurant.outletCount ?? 1,
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[Auth Login] Unexpected error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/captain-login — (restaurantId OR restaurantCode) + userId + PIN → JWT
router.post('/captain-login', async (req: Request, res: Response) => {
  try {
    const parsed = captainLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { restaurantId, restaurantCode, userId, pin } = parsed.data;

    // Brute-force lockout: per-userId counter, 15-minute TTL
    const lockoutKey = `pin:fail:${userId}`;
    const failCount = await cacheGet<number>(lockoutKey) ?? 0;
    if (failCount >= PIN_LOCKOUT_ATTEMPTS) {
      return res.status(429).json({ error: 'Account temporarily locked. Try again in 15 minutes.' });
    }

    // Resolve restaurant
    let restaurant;
    if (restaurantCode) {
      restaurant = await prisma.outlet.findUnique({
        where: { restaurantCode: restaurantCode.trim().toUpperCase() }
      });
    } else {
      restaurant = await prisma.outlet.findUnique({ where: { id: restaurantId } });
    }

    logger.info(`[Auth Captain Login] Attempt`);

    if (!restaurant) {
      logger.info(`[Auth Captain Login] Restaurant not found`);
      await cacheSet(lockoutKey, failCount + 1, PIN_LOCKOUT_TTL_SECONDS);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!restaurant.isActive) {
      logger.info(`[Auth Captain Login] Restaurant inactive: ${restaurant.id}`);
      await cacheSet(lockoutKey, failCount + 1, PIN_LOCKOUT_TTL_SECONDS);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, outletId: restaurant.id },
      include: { outlet: true }
    });

    if (!user) {
      logger.info(`[Auth Captain Login] User not found`);
      await cacheSet(lockoutKey, failCount + 1, PIN_LOCKOUT_TTL_SECONDS);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.pin) {
      logger.info(`[Auth Captain Login] User has no PIN`);
      await cacheSet(lockoutKey, failCount + 1, PIN_LOCKOUT_TTL_SECONDS);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await comparePassword(pin, user.pin);
    logger.info(`[Auth Captain Login] PIN comparison: role=${user.role}`);
    if (!isValid) {
      await cacheSet(lockoutKey, failCount + 1, PIN_LOCKOUT_TTL_SECONDS);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Clear lockout on successful login
    await cacheDelete(lockoutKey);

    if (!user.isActive) {
      logger.info(`[Auth Captain Login] User inactive`);
      return res.status(403).json({ error: 'Account is inactive' });
    }

    if (user.role !== 'CAPTAIN' && user.role !== 'CASHIER') {
      logger.info(`[Auth Captain Login] Role rejected: role=${user.role}`);
      return res.status(403).json({ error: 'Only captains and cashiers can login with PIN' });
    }

    logger.info(`[Auth Captain Login] Success: role=${user.role}, restaurant=${restaurant.id}`);

    const token = signToken({
      userId: user.id,
      role: user.role,
      restaurantId: user.outletId,
      restaurantCode: restaurant.restaurantCode,
      slug: restaurant.slug,
      organizationId: restaurant.organizationId
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        restaurantId: user.outletId,
        restaurantCode: restaurant.restaurantCode
      },
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        restaurantCode: restaurant.restaurantCode,
        logoUrl: restaurant.logoUrl ?? null,
        receiptHeader: restaurant.receiptHeader ?? null,
        receiptSubHeader: restaurant.receiptSubHeader ?? null,
        themePrimary: restaurant.themePrimary ?? null,
        printerConfig: restaurant.printerConfig ?? null,
        barUnitMl: restaurant.barUnitMl,
        fullBottleMl: restaurant.fullBottleMl,
        gstCategory: restaurant.gstCategory ?? 'NON_AC',
        gstRate: restaurant.gstRate ?? null,
        gstRegistered: restaurant.gstRegistered ?? true,
        pricesIncludeGst: restaurant.pricesIncludeGst ?? false,
        restaurantType: restaurant.restaurantType ?? 'DINE_IN',
        outletCount: restaurant.outletCount ?? 1,
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[Auth Captain Login] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me — requires auth, returns current user
router.get('/me', requireAuth as any, async (req: Request, res: Response) => {
  const r = req as AuthRequest;
  try {
    const user = await prisma.user.findUnique({
      where: { id: r.user!.userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;
    const outlet = await prisma.outlet.findUnique({ where: { id: restaurantId } });

    return res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurantId,
        permissions: (user.permissions as Record<string, any>) || {},
      },
      restaurant: {
        id: outlet?.id,
        name: outlet?.name,
        slug: outlet?.slug,
        restaurantType: outlet?.restaurantType ?? 'DINE_IN',
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[Auth Me] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/forgot-password — generate reset token, console.log (real email Week 2)
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { email, restaurantCode } = parsed.data;

    const code = restaurantCode.trim().toUpperCase();
    const restaurant = await prisma.outlet.findUnique({
      where: { restaurantCode: code }
    });

    if (!restaurant) {
      return res.json({ message: 'If email exists, reset link will be sent' });
    }

    const user = await prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), outletId: restaurant.id }
    });

    if (!user) {
      // Don't reveal if email exists; redact from logs
      logger.info(`[Auth Forgot Password] Email not found`);
      return res.json({ message: 'If email exists, reset link will be sent' });
    }

    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only owners and admins can reset password' });
    }

    // Generate cryptographically secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenAt = new Date(Date.now() + 3600000); // 1 hour from now

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenAt }
    });

    await sendPasswordResetEmail(user.email!, resetToken, restaurant.name);

    return res.json({ message: 'If email exists, reset link will be sent' });
  } catch (error) {
    logger.error({ err: error }, '[Auth Forgot Password] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/reset-password — validate token, update passwordHash
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { token, password } = parsed.data;

    const user = await prisma.user.findFirst({
      where: { resetToken: token },
      include: { outlet: true }
    });

    if (!user || !user.resetTokenAt || user.resetTokenAt < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await hashPassword(password);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetToken: null,
        resetTokenAt: null
      }
    });

    logger.info(`[Auth Reset Password] Password reset`);

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    logger.error({ err: error }, '[Auth Reset Password] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/crew?restaurantId=xxx — returns active captains and cashiers (no PINs)
// Accepts either the DB cuid (restaurantId) OR the restaurant slug for convenience
router.get('/crew', optionalAuth as any, async (req: Request, res: Response) => {
  try {
    const { restaurantId } = req.query;

    if (!restaurantId || typeof restaurantId !== 'string') {
      return res.status(400).json({ error: 'restaurantId query param required' });
    }

    // Resolve: accept DB cuid, slug, or restaurantCode
    const restaurant = await prisma.outlet.findFirst({
      where: {
        OR: [
          { id: restaurantId },
          { slug: restaurantId },
          { restaurantCode: restaurantId.toUpperCase() }
        ]
      }
    });

    if (!restaurant) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }

    const users = await prisma.user.findMany({
      where: {
        outletId: restaurant.id,
        role: { in: ['CAPTAIN', 'CASHIER'] },
        isActive: true
      },
      select: { id: true, name: true, role: true }
    });

    const captains = users.filter(u => u.role === 'CAPTAIN');
    const cashiers = users.filter(u => u.role === 'CASHIER');

    return res.json({ captains, cashiers, outletId: restaurant.id });
  } catch (error) {
    logger.error({ err: error }, '[Auth Crew] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh — sliding 7-day window. Accepts current JWT, returns fresh one.
router.post('/refresh', requireAuth as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const user = await prisma.user.findUnique({
      where: { id: r.user!.userId },
      include: { outlet: true }
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const restaurant = await prisma.outlet.findUnique({
      where: { id: user.outletId }
    });

    if (!restaurant || !restaurant.isActive) {
      return res.status(401).json({ error: 'Restaurant not found or inactive' });
    }

    const token = signToken({
      userId: user.id,
      email: user.email || '',
      role: user.role,
      restaurantId: user.outletId,
      activeRestaurantId: r.user!.activeRestaurantId ?? user.outletId,
      restaurantCode: restaurant.restaurantCode,
      slug: restaurant.slug,
      organizationId: restaurant.organizationId
    });

    return res.json({ token });
  } catch (error) {
    logger.error({ err: error }, '[Auth Refresh] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/switch-outlet — switch active outlet for multi-outlet users
router.post('/switch-outlet', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const { outletId } = req.body;

    if (!outletId || typeof outletId !== 'string') {
      return res.status(400).json({ error: 'outletId is required' });
    }

    const access = await prisma.outletAccess.findUnique({
      where: { userId_outletId: { userId: r.user!.userId, outletId } }
    });

    if (!access) {
      return res.status(403).json({ error: 'Access denied to this outlet' });
    }

    const outlet = await prisma.outlet.findUnique({ where: { id: outletId } });
    if (!outlet || !outlet.isActive) {
      return res.status(404).json({ error: 'Outlet not found or inactive' });
    }

    const user = await prisma.user.findUnique({ where: { id: r.user!.userId } });
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const token = signToken({
      userId: user.id,
      email: user.email || '',
      role: user.role,
      restaurantId: user.outletId,
      activeRestaurantId: outletId,
      restaurantCode: outlet.restaurantCode,
      slug: outlet.slug,
      organizationId: outlet.organizationId
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurantId: outletId,
        restaurantCode: outlet.restaurantCode
      },
      restaurant: {
        id: outlet.id,
        name: outlet.name,
        slug: outlet.slug,
        restaurantCode: outlet.restaurantCode,
        logoUrl: outlet.logoUrl ?? null,
        receiptHeader: outlet.receiptHeader ?? null,
        receiptSubHeader: outlet.receiptSubHeader ?? null,
        themePrimary: outlet.themePrimary ?? null,
        printerConfig: outlet.printerConfig ?? null,
        barUnitMl: outlet.barUnitMl,
        fullBottleMl: outlet.fullBottleMl,
        gstCategory: outlet.gstCategory ?? 'NON_AC',
        gstRate: outlet.gstRate ?? null,
        gstRegistered: outlet.gstRegistered ?? true,
        pricesIncludeGst: outlet.pricesIncludeGst ?? false,
        restaurantType: outlet.restaurantType ?? 'DINE_IN',
        outletCount: outlet.outletCount ?? 1,
      }
    });
  } catch (error) {
    logger.error({ err: error }, '[Auth Switch Outlet] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/staff — protected staff list for current tenant
router.get('/staff', authenticate as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId ?? r.user!.restaurantId;
    const roleParam = req.query.role as string | undefined;

    const where: any = { restaurantId, isActive: true };
    if (roleParam) where.role = roleParam.toUpperCase();

    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, role: true, pin: true, permissions: true },
      orderBy: { name: 'asc' }
    });

    const masked = users.map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      pin: u.pin ? '****' : null,
      permissions: (u.permissions as Record<string, any>) || {},
    }));

    return res.json(masked);
  } catch (error) {
    logger.error({ err: error }, '[Auth Staff] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/staff — create CAPTAIN or CASHIER (OWNER/ADMIN only)
router.post('/staff', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId || r.user!.restaurantId;
    const { name, role, pin, permissions } = req.body;

    if (!name || !role || !pin) {
      return res.status(400).json({ error: 'name, role, and pin are required' });
    }
    if (!['CAPTAIN', 'CASHIER'].includes(role)) {
      return res.status(400).json({ error: 'role must be CAPTAIN or CASHIER' });
    }
    if (String(pin).length !== 4) {
      return res.status(400).json({ error: 'pin must be 4 digits' });
    }

    const pinHash = await hashPassword(String(pin));
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        role: role.toUpperCase(),
        pin: pinHash,
        outletId: restaurantId,
        isActive: true,
        permissions: permissions || undefined,
      },
      select: { id: true, name: true, role: true, permissions: true }
    });

    return res.status(201).json(user);
  } catch (error) {
    logger.error({ err: error }, '[Auth Staff Create] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/auth/staff/:id — update name, pin, or isActive (OWNER/ADMIN only)
router.patch('/staff/:id', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId || r.user!.restaurantId;
    const id = req.params.id as string;
    const { name, pin, isActive, permissions } = req.body;

    const existing = await prisma.user.findFirst({
      where: { id, outletId: restaurantId }
    });
    if (!existing || !['CAPTAIN', 'CASHIER'].includes(existing.role)) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const data: any = {};
    if (name !== undefined) data.name = name.trim();
    if (pin !== undefined) {
      if (String(pin).length !== 4) {
        return res.status(400).json({ error: 'pin must be 4 digits' });
      }
      data.pin = await hashPassword(String(pin));
    }
    if (isActive !== undefined) data.isActive = Boolean(isActive);
    if (permissions !== undefined) data.permissions = permissions;

    const updated = await prisma.user.update({
      where: { id: id as string },
      data,
      select: { id: true, name: true, role: true, isActive: true, permissions: true }
    });

    if (isActive !== undefined) {
      await invalidateUserActiveCache(id);
    }

    return res.json(updated);
  } catch (error) {
    logger.error({ err: error }, '[Auth Staff Update] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/staff/:id — soft-delete (set isActive: false) (OWNER/ADMIN only)
router.delete('/staff/:id', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.activeRestaurantId || r.user!.restaurantId;
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({
      where: { id, outletId: restaurantId }
    });
    if (!existing || !['CAPTAIN', 'CASHIER'].includes(existing.role)) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    await prisma.user.update({
      where: { id: id as string },
      data: { isActive: false }
    });

    await invalidateUserActiveCache(id);

    return res.json({ message: 'Staff member deactivated' });
  } catch (error) {
    logger.error({ err: error }, '[Auth Staff Delete] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password — protected by authenticate, requires currentPassword
router.post('/change-password', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    }
    const { currentPassword, newPassword } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: r.user!.userId }
    });
    if (!user || !user.passwordHash) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await comparePassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash }
    });

    return res.json({ message: 'Password updated successfully' });
  } catch (error) {
    logger.error({ err: error }, '[Auth Change Password] Error');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };

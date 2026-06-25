import { Router, Request, Response } from 'express';
import { AuthRequest, authenticate, optionalAuth } from '../middleware/auth';
import { withTenantContext } from '../middleware/tenantContext';
import { z } from 'zod';
import { hashPassword, comparePassword, signToken, verifyToken, requireAuth } from '../lib/auth';
import { requireRole } from '../middleware/auth';
import prisma from '../lib/prisma';
import { sendPasswordResetEmail } from '../lib/email';

const router = Router();

// POST /api/auth/login — restaurantCode + email + password → JWT (for OWNER/ADMIN)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password, restaurantCode } = req.body;

    if (!email || !password || !restaurantCode) {
      return res.status(400).json({ error: 'Restaurant ID, email and password are required' });
    }

    const code = restaurantCode.trim().toUpperCase();
    const emailNormalized = email.trim().toLowerCase();
    console.log(`[Auth Login] Attempt: code=${code}, email=${emailNormalized}`);

    const restaurant = await prisma.restaurant.findUnique({
      where: { restaurantCode: code }
    });

    if (!restaurant) {
      console.log(`[Auth Login] Restaurant not found: ${code}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!restaurant.isActive) {
      console.log(`[Auth Login] Restaurant inactive: ${code}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await prisma.user.findFirst({
      where: { email: emailNormalized, restaurantId: restaurant.id },
      include: { restaurant: true }
    });

    if (!user) {
      console.log(`[Auth Login] User not found: ${emailNormalized} in restaurant ${restaurant.id}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.passwordHash) {
      console.log(`[Auth Login] User has no passwordHash: ${user.id}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await comparePassword(password, user.passwordHash);
    console.log(`[Auth Login] Password comparison: isValid=${isValid}, role=${user.role}, isActive=${user.isActive}`);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only owners and admins can login with email/password' });
    }

    const token = signToken({
      userId: user.id,
      email: user.email!,
      role: user.role,
      restaurantId: user.restaurantId,
      restaurantCode: restaurant.restaurantCode,
      slug: user.restaurant.slug,
      billingStatus: restaurant.billingStatus
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        restaurantId: user.restaurantId,
        restaurantCode: restaurant.restaurantCode
      },
      restaurant: {
        id: user.restaurant.id,
        name: user.restaurant.name,
        slug: user.restaurant.slug,
        restaurantCode: restaurant.restaurantCode,
        logoUrl: user.restaurant.logoUrl ?? null,
        receiptHeader: user.restaurant.receiptHeader ?? null,
        receiptSubHeader: user.restaurant.receiptSubHeader ?? null,
        themePrimary: user.restaurant.themePrimary ?? null,
        printerConfig: user.restaurant.printerConfig ?? null,
        barUnitMl: user.restaurant.barUnitMl,
        fullBottleMl: user.restaurant.fullBottleMl,
        plan: user.restaurant.plan,
        billingStatus: user.restaurant.billingStatus,
        features: user.restaurant.features ?? null,
      }
    });
  } catch (error) {
    console.error('[Auth Login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/captain-login — (restaurantId OR restaurantCode) + userId + PIN → JWT
router.post('/captain-login', async (req: Request, res: Response) => {
  try {
    const { restaurantId, restaurantCode, userId, pin } = req.body;

    if (!userId || !pin) {
      return res.status(400).json({ error: 'userId and PIN required' });
    }
    if (!restaurantId && !restaurantCode) {
      return res.status(400).json({ error: 'restaurantId or restaurantCode required' });
    }

    // Resolve restaurant
    let restaurant;
    if (restaurantCode) {
      restaurant = await prisma.restaurant.findUnique({
        where: { restaurantCode: restaurantCode.trim().toUpperCase() }
      });
    } else {
      restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    }

    if (!restaurant || !restaurant.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, restaurantId: restaurant.id },
      include: { restaurant: true }
    });

    if (!user || !user.pin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await comparePassword(pin, user.pin);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Account is inactive' });
    }

    if (user.role !== 'CAPTAIN' && user.role !== 'CASHIER') {
      return res.status(403).json({ error: 'Only captains and cashiers can login with PIN' });
    }

    const token = signToken({
      userId: user.id,
      role: user.role,
      restaurantId: user.restaurantId,
      restaurantCode: restaurant.restaurantCode,
      slug: user.restaurant.slug,
      billingStatus: restaurant.billingStatus
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        restaurantId: user.restaurantId,
        restaurantCode: restaurant.restaurantCode
      },
      restaurant: {
        id: user.restaurant.id,
        name: user.restaurant.name,
        slug: user.restaurant.slug,
        restaurantCode: restaurant.restaurantCode,
        logoUrl: user.restaurant.logoUrl ?? null,
        receiptHeader: user.restaurant.receiptHeader ?? null,
        receiptSubHeader: user.restaurant.receiptSubHeader ?? null,
        themePrimary: user.restaurant.themePrimary ?? null,
        printerConfig: user.restaurant.printerConfig ?? null,
        barUnitMl: user.restaurant.barUnitMl,
        fullBottleMl: user.restaurant.fullBottleMl,
        plan: user.restaurant.plan,
        billingStatus: user.restaurant.billingStatus,
        features: user.restaurant.features ?? null,
      }
    });
  } catch (error) {
    console.error('[Auth Captain Login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me — requires auth, returns current user
router.get('/me', requireAuth as any, (req: Request, res: Response) => {
  const r = req as AuthRequest;
  (async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: r.user!.userId },
        include: { restaurant: true }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          restaurantId: user.restaurantId
        },
        restaurant: {
          id: user.restaurant.id,
          name: user.restaurant.name,
          slug: user.restaurant.slug
        }
      });
    } catch (error) {
      console.error('[Auth Me] Error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })();
});

// POST /api/auth/forgot-password — generate reset token, console.log (real email Week 2)
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email, restaurantCode } = req.body;

    if (!email || !restaurantCode) {
      return res.status(400).json({ error: 'Email and restaurantCode are required' });
    }

    const code = restaurantCode.trim().toUpperCase();
    const restaurant = await prisma.restaurant.findUnique({
      where: { restaurantCode: code }
    });

    if (!restaurant) {
      return res.json({ message: 'If email exists, reset link will be sent' });
    }

    const user = await prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), restaurantId: restaurant.id }
    });

    if (!user) {
      // Don't reveal if email exists, but log it
      console.log(`[Auth Forgot Password] Email not found: ${email}`);
      return res.json({ message: 'If email exists, reset link will be sent' });
    }

    if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only owners and admins can reset password' });
    }

    // Generate reset token (simple random string for now)
    const resetToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const resetTokenAt = new Date(Date.now() + 3600000); // 1 hour from now

    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken, resetTokenAt }
    });

    await sendPasswordResetEmail(user.email!, resetToken, restaurant.name);

    return res.json({ message: 'If email exists, reset link will be sent' });
  } catch (error) {
    console.error('[Auth Forgot Password] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/reset-password — validate token, update passwordHash
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const user = await prisma.user.findFirst({
      where: { resetToken: token },
      include: { restaurant: true }
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

    console.log(`[Auth Reset Password] Password reset for user: ${user.email}`);

    return res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('[Auth Reset Password] Error:', error);
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
    const restaurant = await prisma.restaurant.findFirst({
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
        restaurantId: restaurant.id,
        role: { in: ['CAPTAIN', 'CASHIER'] },
        isActive: true
      },
      select: { id: true, name: true, role: true }
    });

    const captains = users.filter(u => u.role === 'CAPTAIN');
    const cashiers = users.filter(u => u.role === 'CASHIER');

    return res.json({ captains, cashiers, restaurantId: restaurant.id });
  } catch (error) {
    console.error('[Auth Crew] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh — sliding 7-day window. Accepts current JWT, returns fresh one.
router.post('/refresh', requireAuth as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const user = await prisma.user.findUnique({
      where: { id: r.user!.userId },
      include: { restaurant: true }
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: user.restaurantId }
    });

    if (!restaurant || !restaurant.isActive) {
      return res.status(401).json({ error: 'Restaurant not found or inactive' });
    }

    const token = signToken({
      userId: user.id,
      email: user.email!,
      role: user.role,
      restaurantId: user.restaurantId,
      restaurantCode: restaurant.restaurantCode,
      slug: restaurant.slug,
      billingStatus: restaurant.billingStatus
    });

    return res.json({ token });
  } catch (error) {
    console.error('[Auth Refresh] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/staff — protected staff list for current tenant
router.get('/staff', authenticate as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.restaurantId;
    const roleParam = req.query.role as string | undefined;

    const where: any = { restaurantId, isActive: true };
    if (roleParam) where.role = roleParam.toUpperCase();

    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, role: true, pin: true },
      orderBy: { name: 'asc' }
    });

    const masked = users.map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      pin: u.pin ? '****' : null
    }));

    return res.json(masked);
  } catch (error) {
    console.error('[Auth Staff] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/staff — create CAPTAIN or CASHIER (OWNER/ADMIN only)
router.post('/staff', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.restaurantId;
    const { name, role, pin } = req.body;

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
        restaurantId,
        isActive: true
      },
      select: { id: true, name: true, role: true }
    });

    return res.status(201).json(user);
  } catch (error) {
    console.error('[Auth Staff Create] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/auth/staff/:id — update name, pin, or isActive (OWNER/ADMIN only)
router.patch('/staff/:id', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.restaurantId;
    const id = req.params.id as string;
    const { name, pin, isActive } = req.body;

    const existing = await prisma.user.findFirst({
      where: { id, restaurantId }
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

    const updated = await prisma.user.update({
      where: { id: id as string },
      data,
      select: { id: true, name: true, role: true, isActive: true }
    });

    return res.json(updated);
  } catch (error) {
    console.error('[Auth Staff Update] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/auth/staff/:id — soft-delete (set isActive: false) (OWNER/ADMIN only)
router.delete('/staff/:id', authenticate as any, requireRole('OWNER', 'ADMIN') as any, withTenantContext as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const restaurantId = r.user!.restaurantId;
    const id = req.params.id as string;

    const existing = await prisma.user.findFirst({
      where: { id, restaurantId }
    });
    if (!existing || !['CAPTAIN', 'CASHIER'].includes(existing.role)) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    await prisma.user.update({
      where: { id: id as string },
      data: { isActive: false }
    });

    return res.json({ message: 'Staff member deactivated' });
  } catch (error) {
    console.error('[Auth Staff Delete] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/change-password — protected by authenticate, requires currentPassword
router.post('/change-password', authenticate as any, async (req: Request, res: Response) => {
  try {
    const r = req as AuthRequest;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
    }

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
    console.error('[Auth Change Password] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export { router as authRouter };

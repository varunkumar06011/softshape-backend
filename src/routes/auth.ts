import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hashPassword, comparePassword, signToken, verifyToken, requireAuth } from '../lib/auth';

const router = Router();
const prisma = new PrismaClient();

// POST /api/auth/login — email + password → JWT (for OWNER/ADMIN)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { restaurant: true }
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValid = await comparePassword(password, user.passwordHash);
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
      slug: user.restaurant.slug
    });

    return res.json({
      token,
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
    console.error('[Auth Login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/captain-login — captainId + PIN → JWT (bcrypt compare)
router.post('/captain-login', async (req: Request, res: Response) => {
  try {
    const { captainId, pin } = req.body;

    if (!captainId || !pin) {
      return res.status(400).json({ error: 'Captain ID and PIN required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: captainId },
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
      slug: user.restaurant.slug
    });

    return res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
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
    console.error('[Auth Captain Login] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me — requires auth, returns current user
router.get('/me', (req: Request, res: Response) => {
  requireAuth(req, res, async () => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
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
  });
});

// POST /api/auth/forgot-password — generate reset token, console.log (real email Week 2)
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

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

    // Stub: log to console (real email in Week 2)
    console.log(`[Auth Forgot Password] Reset link for ${email}: http://localhost:5173/reset-password?token=${resetToken}`);

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

export { router as authRouter };

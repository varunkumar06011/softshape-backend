// ─────────────────────────────────────────────────────────────────────────────
// Authentication Library — Password Hashing & JWT Management
// ─────────────────────────────────────────────────────────────────────────────
// Core authentication utilities used by the auth routes and middleware:
//   1. Password hashing (bcrypt with 12 rounds)
//   2. JWT signing for authenticated sessions (7-day expiry)
//   3. Pre-auth token for outlet selection during multi-outlet login (10-min expiry)
//   4. JWT verification
//   5. requireAuth middleware (standalone, also re-exported from middleware/auth)
//
// JWT_SECRET must be set in environment variables. The server refuses to start
// if it's missing — this is a hard fail to prevent running with insecure defaults.
// ─────────────────────────────────────────────────────────────────────────────

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { AuthRequest, AuthUser } from '../middleware/auth';

// The secret used to sign/verify JWTs. Hard fail at module load if not set.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[AUTH] FATAL: JWT_SECRET is not set. Set it in Railway environment variables before starting the server.');
}
const JWT_EXPIRY = '7d';  // Staff JWT tokens expire after 7 days

// Hashes a plaintext password using bcrypt with 12 rounds.
// Use this when creating users or changing passwords.
export const hashPassword = (p: string) => bcrypt.hash(p, 12);

// Compares a plaintext password against a bcrypt hash.
// Returns true if the password matches. Use this during login.
export const comparePassword = (p: string, hash: string) => bcrypt.compare(p, hash);

// Signs a JWT for an authenticated user session.
// The payload includes user identity, role, restaurant context, and billing status.
// activeRestaurantId defaults to restaurantId if not provided (single-outlet users).
// The token expires after 7 days (JWT_EXPIRY).
export function signToken(payload: { userId: string; email?: string; role: string; restaurantId: string; activeRestaurantId?: string; organizationId?: string; restaurantCode?: string | null; slug: string; billingStatus?: string | null }) {
  return jwt.sign({ ...payload, activeRestaurantId: payload.activeRestaurantId ?? payload.restaurantId }, JWT_SECRET!, { expiresIn: JWT_EXPIRY });
}

// Signs a short-lived (10-minute) pre-auth token used during multi-outlet login.
// After email+password verification, the user gets this token to select which
// outlet to log into. Once they select, they receive a full signToken() JWT.
// tokenType: 'PRE_AUTH_OUTLET_SELECT' distinguishes this from regular auth tokens.
export function signPreAuthToken(payload: { userId: string; email: string }) {
  return jwt.sign(
    { ...payload, tokenType: 'PRE_AUTH_OUTLET_SELECT' },
    JWT_SECRET!,
    { expiresIn: '10m' },
  );
}

// Verifies a JWT and returns the decoded payload (including iat/exp timestamps).
// Throws jwt.JsonWebTokenError if the token is invalid, expired, or signed with a different secret.
export function verifyToken(token: string): AuthUser & { iat: number; exp: number } {
  return jwt.verify(token, JWT_SECRET!) as unknown as AuthUser & { iat: number; exp: number };
}

// Standalone auth middleware — extracts Bearer token from Authorization header,
// verifies it, and populates req.user with the decoded payload.
// Returns 401 if no token or token is invalid/expired.
// Note: The main middleware/auth.ts also exports authenticate/optionalAuth which
// are used more widely. This is a simpler version for cases where the full
// middleware chain is not needed.
export function requireAuth(req: AuthRequest, res: any, next: any) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
}

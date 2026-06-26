import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('[AUTH] FATAL: JWT_SECRET is not set. Set it in Railway environment variables before starting the server.');
}
const JWT_EXPIRY = '7d';

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const comparePassword = (p: string, hash: string) => bcrypt.compare(p, hash);

export function signToken(payload: { userId: string; email?: string; role: string; restaurantId: string; restaurantCode?: string | null; slug: string; billingStatus?: string | null }) {
  return jwt.sign(payload, JWT_SECRET!, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET!) as ReturnType<typeof signToken> & { iat: number; exp: number };
}

export function requireAuth(req: any, res: any, next: any) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalid or expired' });
  }
}

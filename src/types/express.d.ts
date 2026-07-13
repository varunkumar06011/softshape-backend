// ─────────────────────────────────────────────────────────────────────────────
// Express Request Type Augmentation
// ─────────────────────────────────────────────────────────────────────────────
// Extends the Express Request interface with a `user` property that is populated
// by the authenticate/optionalAuth middleware after JWT verification.
// This provides TypeScript autocomplete and type safety for req.user across
// all route handlers without needing to cast to `any`.
// ─────────────────────────────────────────────────────────────────────────────
import type { AuthUser } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express Request Type Augmentation
// ─────────────────────────────────────────────────────────────────────────────
// Extends the Express Request interface with a `user` property that is populated
// by the authenticate/optionalAuth middleware after JWT verification.
// This provides TypeScript autocomplete and type safety for req.user across
// all route handlers without needing to cast to `any`.
//
// Fields:
//   id/userId        — user's database ID
//   email            — user's email (for owner/admin roles)
//   name             — user's display name
//   role             — one of 'OWNER', 'ADMIN', 'CAPTAIN', 'CASHIER', etc.
//   restaurantId     — the user's home restaurant/outlet ID
//   activeRestaurantId — the currently selected outlet (may differ from restaurantId
//                        when a multi-outlet user switches between outlets)
//   slug             — restaurant URL slug (for public menu links)
//   iat/exp          — JWT issued-at and expiry timestamps (set by jsonwebtoken)
// ─────────────────────────────────────────────────────────────────────────────
declare namespace Express {
  interface Request {
    user?: {
      id?: string;
      userId?: string;
      email?: string;
      name?: string;
      role: string;
      restaurantId: string;
      activeRestaurantId?: string;
      slug?: string;
      iat?: number;
      exp?: number;
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Table QR Signature — HMAC-based URL signing for customer QR codes
// ─────────────────────────────────────────────────────────────────────────────
// Each table QR code contains a URL with an HMAC signature that binds together
// the restaurant slug, table ID, and restaurant ID. This prevents:
//   - Tampering with the QR URL to access a different table
//   - Guessing valid table URLs without knowing the secret
//
// The signature is 8 hex characters (first 4 bytes of HMAC-SHA256).
// This is short enough for a URL but provides 2^32 possible values — sufficient
// for preventing casual guessing. The JWT_SECRET is used as the HMAC key.
//
// Usage:
//   const sig = generateTableSignature(slug, tableId, restaurantId);
//   // URL: https://softshape.in/menu/{slug}/{tableId}?sig={sig}
//   // On the server:
//   if (verifyTableSignature(slug, tableId, restaurantId, sig)) { /* valid */ }
// ─────────────────────────────────────────────────────────────────────────────

import crypto from "crypto";

const SIGNATURE_LENGTH = 16;
const LEGACY_SIGNATURE_LENGTH = 8;

/**
 * Generate a 16-char HMAC signature (64-bit) for a table QR URL.
 * The signature binds slug + tableId + restaurantId together so that
 * changing any one component invalidates the URL.
 */
export function generateTableSignature(
  slug: string,
  tableId: string,
  restaurantId: string
): string {
  const secret = process.env.JWT_SECRET || "fallback-dev-secret";
  return crypto
    .createHmac("sha256", secret)
    .update(`${slug}:${tableId}:${restaurantId}`)
    .digest("hex")
    .substring(0, SIGNATURE_LENGTH);
}

/**
 * Verify that a signature matches the expected HMAC for the given params.
 * Accepts both new 16-char signatures (64-bit) and legacy 8-char signatures
 * (32-bit) so existing printed QR codes continue to work.
 */
export function verifyTableSignature(
  slug: string,
  tableId: string,
  restaurantId: string,
  sig: string
): boolean {
  if (!sig || typeof sig !== "string") return false;
  const secret = process.env.JWT_SECRET || "fallback-dev-secret";
  const fullHmac = crypto
    .createHmac("sha256", secret)
    .update(`${slug}:${tableId}:${restaurantId}`)
    .digest("hex");
  const newSig = fullHmac.substring(0, SIGNATURE_LENGTH);
  const legacySig = fullHmac.substring(0, LEGACY_SIGNATURE_LENGTH);
  return sig === newSig || sig === legacySig;
}

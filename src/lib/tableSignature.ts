import crypto from "crypto";

/**
 * Generate an 8-char HMAC signature for a table QR URL.
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
    .substring(0, 8);
}

/**
 * Verify that a signature matches the expected HMAC for the given params.
 */
export function verifyTableSignature(
  slug: string,
  tableId: string,
  restaurantId: string,
  sig: string
): boolean {
  if (!sig || typeof sig !== "string") return false;
  const expected = generateTableSignature(slug, tableId, restaurantId);
  return expected === sig;
}

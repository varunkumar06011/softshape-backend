// ─────────────────────────────────────────────────────────────────────────────
// Verification Token — OTP Proof Signing & Verification
// ─────────────────────────────────────────────────────────────────────────────
// During onboarding, users must verify their email and phone via OTP.
// Once an OTP is verified, this module issues a signed JWT "proof" that the
// verification was completed. The proof is later checked during the onboarding
// submission to ensure the user actually verified their contact info.
//
// The proof includes:
//   - kind:      'email' or 'phone'
//   - value:     the email address or phone number that was verified
//   - sessionId: ties the proof to a specific onboarding session
//
// Proofs expire after 2 hours. The secret is VERIFICATION_SECRET (separate from
// JWT_SECRET so JWT rotation doesn't invalidate in-progress onboarding proofs).
//
// Usage:
//   const proof = issueVerificationProof('email', 'user@example.com', sessionId);
//   // ... later during onboarding submission ...
//   if (checkVerificationProof(proof, 'email', 'user@example.com', sessionId)) {
//     // proceed with onboarding
//   }
// ─────────────────────────────────────────────────────────────────────────────

import jwt from "jsonwebtoken";

// Secret for signing verification proofs. Falls back to JWT_SECRET if VERIFICATION_SECRET is not set.
const VERIFY_SECRET = process.env.VERIFICATION_SECRET || process.env.JWT_SECRET!;

// Issues a signed JWT proof that an email or phone was verified via OTP.
// The proof is valid for 2 hours and is tied to the given sessionId.
export function issueVerificationProof(kind: "email" | "phone", value: string, sessionId: string) {
  return jwt.sign({ kind, value, sessionId }, VERIFY_SECRET, { expiresIn: "2h" });
}

// Verifies a verification proof JWT. Returns true only if:
//   1. The JWT signature is valid (not tampered)
//   2. The kind matches (email/phone)
//   3. The value matches the expected email/phone
//   4. The sessionId matches the current onboarding session
// Returns false if any check fails or the token is expired.
export function checkVerificationProof(proof: string, kind: "email" | "phone", value: string, sessionId: string) {
  try {
    const decoded = jwt.verify(proof, VERIFY_SECRET) as any;
    return decoded.kind === kind && decoded.value === value && decoded.sessionId === sessionId;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification Routes — Email OTP and Phone OTP verification
// ─────────────────────────────────────────────────────────────────────────────
// Handles email and phone verification during onboarding:
//   1. Email OTP: generates a 6-digit code, sends via Resend, verifies server-side
//   2. Phone OTP: frontend uses Firebase client SDK for OTP, backend verifies the
//      Firebase ID token and extracts the verified phone number
//
// On successful verification, issues a signed JWT "proof" (via verificationToken.ts)
// that the onboarding flow later submits to confirm the contact was verified.
//
// Security:
//   - OTP rate limiting: 3 sends/min, 10 verify attempts/min
//   - OTP brute-force protection: max 5 incorrect attempts before code is invalidated
//   - OTP TTL: 5 minutes
//   - Redis required for OTP storage (returns 503 if not configured)
//   - In non-production with no RESEND_API_KEY: mock mode logs the OTP instead of sending
//
// Endpoints:
//   POST /api/verification/email/send  — send email OTP
//   POST /api/verification/email/verify — verify email OTP, returns proof JWT
//   POST /api/verification/phone/verify — verify Firebase phone token, returns proof JWT
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import logger from "../lib/logger";
import { Resend } from "resend";
import { randomInt } from "crypto";
import rateLimit from "express-rate-limit";
import { cacheGet, cacheSet, cacheDelete, isCacheReady } from "../lib/cache";
import { verifyFirebaseIdToken } from "../lib/firebaseAdmin";
import { issueVerificationProof } from "../lib/verificationToken";

const router = Router();

// Lazily initializes the Resend email client. Returns null if API key is not set.
function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

// Tight limiter — OTP spam is a real cost/abuse vector
const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  keyGenerator: (req: any) => req.body?.email || req.body?.sessionId || req.ip,
  message: { error: "Too many OTP requests, please wait a minute" },
});

// Lighter limiter for phone verification — protects against junk-token hammering
const phoneVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.body?.sessionId || req.ip,
  message: { error: "Too many phone verification attempts, please wait a minute" },
});

// Generates a 6-digit OTP code (100000–999999)
function generateOtp() {
  return String(randomInt(100000, 1000000)); // 6 digits
}

// ── EMAIL OTP ──────────────────────────────────────────────
router.post("/email/send", otpLimiter, async (req, res) => {
  const { email, sessionId } = req.body;
  if (!email || !sessionId) return res.status(400).json({ error: "email and sessionId required" });

  if (!isCacheReady()) {
    return res.status(503).json({ error: "Email verification is unavailable: Redis is not configured. Set REDIS_URL to enable OTP." });
  }

  const otp = generateOtp();
  const key = `otp:email:${sessionId}:${email.toLowerCase()}`;
  await cacheSet(key, { otp, attempts: 0 }, 5 * 60); // 5 min TTL

  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Email OTP] RESEND_API_KEY not set in production — refusing to send mock OTP');
      return res.status(503).json({ error: 'Email verification is unavailable. Please contact support.' });
    }
    logger.warn(`[Mock Email] Would have sent OTP ${otp} to ${email}`);
    return res.json({ sent: true, mock: true });
  }

  const resend = getResendClient();
  if (!resend) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[Email OTP] Resend client initialization failed in production — refusing to send mock OTP');
      return res.status(503).json({ error: 'Email verification is unavailable. Please contact support.' });
    }
    logger.warn(`[Mock Email] Would have sent OTP ${otp} to ${email}`);
    return res.json({ sent: true, mock: true });
  }

  await resend.emails.send({
    from: "Softshape <noreply@softshape.in>",
    to: email,
    subject: "Your Softshape verification code",
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
      <h2>Verify your email</h2>
      <p>Your code is:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;">${otp}</p>
      <p style="color:#999;font-size:12px;">Expires in 5 minutes.</p>
    </div>`,
  });

  res.json({ sent: true });
});

// OTP verification limiter — prevents brute-force of 6-digit codes
const otpVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.body?.email || req.body?.sessionId || req.ip,
  message: { error: "Too many verification attempts, please wait a minute" },
});

router.post("/email/verify", otpVerifyLimiter, async (req, res) => {
  const { email, sessionId, otp } = req.body;
  if (!email || !sessionId || !otp) return res.status(400).json({ error: "Missing fields" });

  if (!isCacheReady()) {
    return res.status(503).json({ error: "Email verification is unavailable: Redis is not configured. Set REDIS_URL to enable OTP." });
  }

  const key = `otp:email:${sessionId}:${email.toLowerCase()}`;
  const record = await cacheGet<{ otp: string; attempts: number }>(key);

  if (!record) return res.status(400).json({ error: "Code expired or not found, request a new one" });
  if (record.attempts >= 5) {
    await cacheDelete(key);
    return res.status(429).json({ error: "Too many incorrect attempts, request a new code" });
  }
  if (record.otp !== otp) {
    await cacheSet(key, { ...record, attempts: record.attempts + 1 }, 5 * 60);
    return res.status(400).json({ error: "Incorrect code" });
  }

  await cacheDelete(key);
  const proof = issueVerificationProof("email", email.toLowerCase(), sessionId);
  res.json({ verified: true, proof });
});

// ── PHONE OTP (Firebase) ───────────────────────────────────
// Frontend already ran Firebase's signInWithPhoneNumber + confirm() flow.
// It sends us the resulting Firebase ID token; we just verify it server-side.
router.post("/phone/verify", phoneVerifyLimiter, async (req, res) => {
  const { idToken, sessionId } = req.body;
  if (!idToken || !sessionId) return res.status(400).json({ error: "idToken and sessionId required" });

  try {
    const phoneNumber = await verifyFirebaseIdToken(idToken);
    const proof = issueVerificationProof("phone", phoneNumber, sessionId);
    res.json({ verified: true, phoneNumber, proof });
  } catch (err: any) {
    res.status(401).json({ error: "Phone verification failed", detail: err.message });
  }
});

export { router as verificationRouter };

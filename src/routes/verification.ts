import { Router } from "express";
import { Resend } from "resend";
import rateLimit from "express-rate-limit";
import { cacheGet, cacheSet, cacheDelete } from "../lib/cache";
import { verifyFirebaseIdToken } from "../lib/firebaseAdmin";
import { issueVerificationProof } from "../lib/verificationToken";

const router = Router();
const resend = new Resend(process.env.RESEND_API_KEY);

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

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

// ── EMAIL OTP ──────────────────────────────────────────────
router.post("/email/send", otpLimiter, async (req, res) => {
  const { email, sessionId } = req.body;
  if (!email || !sessionId) return res.status(400).json({ error: "email and sessionId required" });

  const otp = generateOtp();
  const key = `otp:email:${sessionId}:${email.toLowerCase()}`;
  await cacheSet(key, { otp, attempts: 0 }, 5 * 60); // 5 min TTL

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

router.post("/email/verify", async (req, res) => {
  const { email, sessionId, otp } = req.body;
  if (!email || !sessionId || !otp) return res.status(400).json({ error: "Missing fields" });

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

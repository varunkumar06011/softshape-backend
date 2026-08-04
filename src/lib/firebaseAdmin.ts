// ─────────────────────────────────────────────────────────────────────────────
// Firebase Admin SDK — Phone OTP Verification
// ─────────────────────────────────────────────────────────────────────────────
// Initializes the Firebase Admin SDK for server-side phone OTP verification.
// During onboarding, the frontend uses Firebase client SDK to send OTP to the
// user's phone. The frontend then sends the Firebase ID token to the backend,
// which uses verifyFirebaseIdToken() to verify the token and extract the
// verified phone number.
//
// Required env vars:
//   FIREBASE_PROJECT_ID   — Firebase project ID
//   FIREBASE_CLIENT_EMAIL — Firebase service account email
//   FIREBASE_PRIVATE_KEY  — Firebase service account private key (with \n escapes)
//
// If credentials are missing, a warning is logged and phone OTP verification will fail.
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, cert, getApps } from "firebase-admin/app";
import logger from "./logger";
import { getAuth } from "firebase-admin/auth";

// Initialize Firebase Admin only once (checks getApps() to avoid double-init).
// Replaces \n escape sequences in the private key with actual newlines (env var format).
if (!getApps().length) {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
        }),
      });
    } catch (err) {
      logger.error({ err }, "[Firebase] Failed to initialize admin SDK:");
    }
  } else {
    logger.warn("[Firebase] Missing FIREBASE credentials in .env - Phone OTP verification will fail.");
  }
}

// Verifies a Firebase ID token and extracts the verified phone number.
// Retries up to 3 times with 2-second gaps because Firebase Admin fetches
// Google public keys on first call, which can be slow (cold start).
//
// Parameters:
//   idToken — Firebase ID token from the client (after OTP verification)
//
// Returns: the verified phone number (e.g. "+919876543210")
// Throws: if token is invalid, has no phone_number, or all retries fail.
export async function verifyFirebaseIdToken(idToken: string) {
  // Firebase Admin fetches Google public keys on first call — can be slow
  // Retry up to 3 times with 2s gap before giving up
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const decoded = await getAuth().verifyIdToken(idToken);
      if (!decoded.phone_number) {
        throw new Error("Token has no verified phone number");
      }
      return decoded.phone_number; // e.g. "+919876543210"
    } catch (err: any) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });
}

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

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
  const decoded = await getAuth().verifyIdToken(idToken);
  if (!decoded.phone_number) {
    throw new Error("Token has no verified phone number");
  }
  return decoded.phone_number; // e.g. "+919876543210"
}

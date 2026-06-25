import jwt from "jsonwebtoken";

const VERIFY_SECRET = process.env.JWT_SECRET!;

export function issueVerificationProof(kind: "email" | "phone", value: string, sessionId: string) {
  return jwt.sign({ kind, value, sessionId }, VERIFY_SECRET, { expiresIn: "30m" });
}

export function checkVerificationProof(proof: string, kind: "email" | "phone", value: string, sessionId: string) {
  try {
    const decoded = jwt.verify(proof, VERIFY_SECRET) as any;
    return decoded.kind === kind && decoded.value === value && decoded.sessionId === sessionId;
  } catch {
    return false;
  }
}

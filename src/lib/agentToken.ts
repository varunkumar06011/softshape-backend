// ─────────────────────────────────────────────────────────────────────────────
// Windows Print Agent Token Management
// ─────────────────────────────────────────────────────────────────────────────
// Provides JWT signing and verification for the Windows Print Agent desktop app.
// The agent uses a separate secret (AGENT_JWT_SECRET) from the main app JWT
// so that agent tokens can be rotated independently of staff auth tokens.
//
// Two token purposes:
//   - "agent-setup"    — short-lived token used during initial agent pairing
//   - "agent-session"  — longer-lived token for ongoing agent sessions
//
// Usage:
//   signAgentToken({ restaurantId, purpose: "agent-session", agentId }, "7d")
//   const payload = verifyAgentToken(token); // throws if invalid/expired
// ─────────────────────────────────────────────────────────────────────────────

import jwt from "jsonwebtoken";

// Secret used for signing agent JWTs. Falls back to JWT_SECRET, then to a
// hardcoded fallback (dev only — should never be used in production).
export const AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET || process.env.JWT_SECRET || "fallback-secret";

// Payload structure for agent tokens. `purpose` distinguishes setup vs session tokens.
export interface AgentTokenPayload {
  restaurantId: string;                              // The restaurant this agent belongs to
  purpose: "agent-setup" | "agent-session";           // Token purpose (setup=pairing, session=ongoing)
  agentId?: string;                                  // Optional agent DB record ID
  restaurantCode?: string;                           // Optional restaurant join code
}

// Signs an agent JWT with the given payload and expiry.
// Use "agent-setup" for short-lived pairing tokens (e.g. 10m),
// "agent-session" for long-lived session tokens (e.g. 7d).
export function signAgentToken(
  payload: Omit<AgentTokenPayload, "purpose"> & { purpose: "agent-setup" | "agent-session" },
  expiresIn: string,
): string {
  return jwt.sign(payload as object, AGENT_JWT_SECRET, { expiresIn: expiresIn as any });
}

// Verifies an agent JWT and returns the decoded payload.
// Throws jwt.JsonWebTokenError if the token is invalid, expired, or signed with a different secret.
export function verifyAgentToken(token: string): AgentTokenPayload {
  return jwt.verify(token, AGENT_JWT_SECRET) as AgentTokenPayload;
}

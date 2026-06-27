import jwt from "jsonwebtoken";

export const AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET || process.env.JWT_SECRET || "fallback-secret";

export interface AgentTokenPayload {
  restaurantId: string;
  purpose: "agent-setup" | "agent-session";
  agentId?: string;
  restaurantCode?: string;
}

export function signAgentToken(
  payload: Omit<AgentTokenPayload, "purpose"> & { purpose: "agent-setup" | "agent-session" },
  expiresIn: string,
): string {
  return jwt.sign(payload as object, AGENT_JWT_SECRET, { expiresIn: expiresIn as any });
}

export function verifyAgentToken(token: string): AgentTokenPayload {
  return jwt.verify(token, AGENT_JWT_SECRET) as AgentTokenPayload;
}

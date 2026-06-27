import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";

describe("agentToken", () => {
  const originalSecret = process.env.AGENT_JWT_SECRET;
  const originalJwtSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    delete process.env.AGENT_JWT_SECRET;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalSecret) process.env.AGENT_JWT_SECRET = originalSecret;
    else delete process.env.AGENT_JWT_SECRET;
    if (originalJwtSecret) process.env.JWT_SECRET = originalJwtSecret;
    vi.resetModules();
  });

  it("should sign and verify a valid agent-setup token", async () => {
    const { signAgentToken, verifyAgentToken } = await import("../agentToken");
    const token = signAgentToken(
      { restaurantId: "r1", purpose: "agent-setup" },
      "15m",
    );
    const decoded = verifyAgentToken(token);
    expect(decoded.restaurantId).toBe("r1");
    expect(decoded.purpose).toBe("agent-setup");
  });

  it("should sign and verify a valid agent-session token", async () => {
    const { signAgentToken, verifyAgentToken } = await import("../agentToken");
    const token = signAgentToken(
      { restaurantId: "r2", purpose: "agent-session", agentId: "a1" },
      "30d",
    );
    const decoded = verifyAgentToken(token);
    expect(decoded.restaurantId).toBe("r2");
    expect(decoded.purpose).toBe("agent-session");
    expect(decoded.agentId).toBe("a1");
  });

  it("should reject a token signed with a different secret", async () => {
    const { verifyAgentToken } = await import("../agentToken");
    const token = jwt.sign(
      { restaurantId: "r1", purpose: "agent-setup" },
      "wrong-secret",
    );
    expect(() => verifyAgentToken(token)).toThrow();
  });

  it("should reject an expired token", async () => {
    const { signAgentToken, verifyAgentToken } = await import("../agentToken");
    const token = signAgentToken(
      { restaurantId: "r1", purpose: "agent-setup" },
      "-1s",
    );
    expect(() => verifyAgentToken(token)).toThrow();
  });

  it("should use AGENT_JWT_SECRET when set separately", async () => {
    process.env.AGENT_JWT_SECRET = "dedicated-agent-secret";
    const { verifyAgentToken } = await import("../agentToken");
    const token = jwt.sign(
      { restaurantId: "r1", purpose: "agent-session" },
      "dedicated-agent-secret",
    );
    const decoded = verifyAgentToken(token);
    expect(decoded.restaurantId).toBe("r1");
  });
});

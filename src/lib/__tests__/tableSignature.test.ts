/**
 * Tests for tableSignature.ts — HMAC generation and verification
 * Run: npx vitest run src/lib/__tests__/tableSignature.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("tableSignature", () => {
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-secret-for-hmac";
  });

  afterEach(() => {
    if (originalSecret) process.env.JWT_SECRET = originalSecret;
    else delete process.env.JWT_SECRET;
  });

  it("should generate an 8-char hex signature", async () => {
    const { generateTableSignature } = await import("../tableSignature");
    const sig = generateTableSignature("my-resto", "table-1", "r-1");
    expect(sig).toHaveLength(8);
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
  });

  it("should generate the same signature for the same inputs", async () => {
    const { generateTableSignature } = await import("../tableSignature");
    const sig1 = generateTableSignature("my-resto", "table-1", "r-1");
    const sig2 = generateTableSignature("my-resto", "table-1", "r-1");
    expect(sig1).toBe(sig2);
  });

  it("should generate different signatures for different slugs", async () => {
    const { generateTableSignature } = await import("../tableSignature");
    const sig1 = generateTableSignature("resto-a", "table-1", "r-1");
    const sig2 = generateTableSignature("resto-b", "table-1", "r-1");
    expect(sig1).not.toBe(sig2);
  });

  it("should generate different signatures for different tableIds", async () => {
    const { generateTableSignature } = await import("../tableSignature");
    const sig1 = generateTableSignature("my-resto", "table-1", "r-1");
    const sig2 = generateTableSignature("my-resto", "table-2", "r-1");
    expect(sig1).not.toBe(sig2);
  });

  it("should generate different signatures for different restaurantIds", async () => {
    const { generateTableSignature } = await import("../tableSignature");
    const sig1 = generateTableSignature("my-resto", "table-1", "r-1");
    const sig2 = generateTableSignature("my-resto", "table-1", "r-2");
    expect(sig1).not.toBe(sig2);
  });

  it("should verify a valid signature", async () => {
    const { generateTableSignature, verifyTableSignature } = await import("../tableSignature");
    const sig = generateTableSignature("my-resto", "table-1", "r-1");
    expect(verifyTableSignature("my-resto", "table-1", "r-1", sig)).toBe(true);
  });

  it("should reject an invalid signature", async () => {
    const { verifyTableSignature } = await import("../tableSignature");
    expect(verifyTableSignature("my-resto", "table-1", "r-1", "deadbeef")).toBe(false);
  });

  it("should reject a null or undefined signature", async () => {
    const { verifyTableSignature } = await import("../tableSignature");
    expect(verifyTableSignature("my-resto", "table-1", "r-1", null as any)).toBe(false);
    expect(verifyTableSignature("my-resto", "table-1", "r-1", undefined as any)).toBe(false);
  });

  it("should reject a signature generated with a different secret", async () => {
    const { generateTableSignature, verifyTableSignature } = await import("../tableSignature");
    // Generate with one secret
    const sig = generateTableSignature("my-resto", "table-1", "r-1");
    // Change secret and verify
    process.env.JWT_SECRET = "different-secret";
    const { verifyTableSignature: verifyWithDifferentSecret } = await import("../tableSignature");
    expect(verifyWithDifferentSecret("my-resto", "table-1", "r-1", sig)).toBe(false);
  });
});

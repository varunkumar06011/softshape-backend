/**
 * Tests for logger configuration — verifies pino logger is properly configured
 * Run: npx vitest run src/lib/__tests__/logger.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Logger", () => {
  it("should export a pino logger instance with info method", async () => {
    const logger = (await import("../logger")).default;
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });

  it("should have service name in base context", async () => {
    const logger = (await import("../logger")).default;
    // pino logger has bindings that contain the base context
    const bindings = logger.bindings();
    expect(bindings.service).toBe("softshape-backend");
  });

  it("should respect LOG_LEVEL environment variable", async () => {
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    vi.resetModules();
    const { default: logger } = await import("../logger");
    expect(logger.level).toBe("debug");
    if (originalLevel) process.env.LOG_LEVEL = originalLevel;
    else delete process.env.LOG_LEVEL;
    vi.resetModules();
  });
});

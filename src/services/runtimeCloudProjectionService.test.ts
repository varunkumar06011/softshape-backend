import { describe, it, expect, beforeEach } from "vitest";
import {
  registerCloudProjection,
  resetCloudProjectionRegistry,
  discoverCloudProjections,
  hasCloudProjection,
  dispatchCloudProjection,
  type CloudProjectionHandler,
} from "./runtimeCloudProjectionService";
import type { RuntimeEventEnvelope } from "./runtimeEventService";

// The cloud projection boundary is a registry + dispatch contract: the event
// service relies on it to reject unprovisioned event types before they reach
// business tables. These tests verify the registry invariants without a live
// Prisma transaction — the handler receives the tx object untouched, so a
// stand-in is sufficient to prove the dispatch path.

const EVENT_A = "order.created";
const EVENT_B = "order.status_changed";

function envelope(eventType: string): RuntimeEventEnvelope {
  return {
    eventId: "evt-1",
    envelopeVersion: 1,
    schemaVersion: 1,
    restaurantId: "r-1",
    runtimeId: "rt-1",
    origin: "runtime",
    aggregate: "order",
    aggregateId: "order-1",
    eventType,
    actorId: "staff-1",
    actorRole: "CASHIER",
    requestId: null,
    correlationId: null,
    causationId: null,
    occurredAt: Date.now(),
    payload: {},
  };
}

describe("runtimeCloudProjectionService registry", () => {
  beforeEach(() => {
    resetCloudProjectionRegistry();
  });

  it("registers and dispatches a handler for a known event type", async () => {
    let called = false;
    const handler: CloudProjectionHandler = async () => {
      called = true;
    };
    registerCloudProjection(EVENT_A, handler);

    expect(hasCloudProjection(EVENT_A)).toBe(true);
    await dispatchCloudProjection({} as any, envelope(EVENT_A));
    expect(called).toBe(true);
  });

  it("rejects duplicate registration for the same event type", () => {
    registerCloudProjection(EVENT_A, async () => {});
    expect(() => registerCloudProjection(EVENT_A, async () => {})).toThrowError(
      /already registered/,
    );
  });

  it("dispatch throws a CloudProjectionMissing error for an unregistered event type", async () => {
    expect(hasCloudProjection(EVENT_B)).toBe(false);
    await expect(dispatchCloudProjection({} as any, envelope(EVENT_B))).rejects.toThrowError(
      /No cloud projection registered/,
    );
  });

  it("discoverCloudProjections reports registered and missing event types", () => {
    registerCloudProjection(EVENT_A, async () => {});

    const discovery = discoverCloudProjections([EVENT_A, EVENT_B]);
    expect(discovery.registered).toEqual([EVENT_A]);
    expect(discovery.missing).toEqual([EVENT_B]);
  });
});

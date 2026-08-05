// ─────────────────────────────────────────────────────────────────────────────
// runtimeCloudProjections.test.ts — Tests for Milestone 2 cloud projections
// ─────────────────────────────────────────────────────────────────────────────
// Verifies that the cloud projection handlers are registered for all
// Milestone 2 event types and that the registry is complete.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  discoverCloudProjections,
  hasCloudProjection,
} from "./runtimeCloudProjectionService";
import { MILESTONE_2_CLOUD_EVENT_TYPES } from "./runtimeCloudProjections";

describe("Milestone 2 cloud projection registration", () => {
  it("registers handlers for all Milestone 2 event types", () => {
    const discovery = discoverCloudProjections(MILESTONE_2_CLOUD_EVENT_TYPES);
    expect(discovery.missing).toEqual([]);
  });

  it("each event type has a registered handler", () => {
    for (const eventType of MILESTONE_2_CLOUD_EVENT_TYPES) {
      expect(hasCloudProjection(eventType)).toBe(true);
    }
  });
});

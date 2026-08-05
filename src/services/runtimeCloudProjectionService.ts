import type { Prisma } from "@prisma/client";
import type { RuntimeEventEnvelope } from "./runtimeEventService";

export type CloudProjectionHandler = (
  tx: Prisma.TransactionClient,
  event: RuntimeEventEnvelope,
) => Promise<void>;

const handlers = new Map<string, CloudProjectionHandler>();

export function registerCloudProjection(
  eventType: string,
  handler: CloudProjectionHandler,
): void {
  if (handlers.has(eventType)) {
    throw new Error(`Cloud projection already registered for '${eventType}'`);
  }
  handlers.set(eventType, handler);
}

export function resetCloudProjectionRegistry(): void {
  handlers.clear();
}

export function discoverCloudProjections(eventTypes: string[]) {
  return {
    registered: [...handlers.keys()].sort(),
    missing: eventTypes.filter((eventType) => !handlers.has(eventType)),
  };
}

export function hasCloudProjection(eventType: string): boolean {
  return handlers.has(eventType);
}

export async function dispatchCloudProjection(
  tx: Prisma.TransactionClient,
  event: RuntimeEventEnvelope,
): Promise<void> {
  const handler = handlers.get(event.eventType);
  if (!handler) {
    const error = new Error(`No cloud projection registered for '${event.eventType}'`);
    error.name = "CloudProjectionMissing";
    throw error;
  }
  await handler(tx, event);
}

import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { dispatchCloudProjection, hasCloudProjection } from "./runtimeCloudProjectionService";

export const RUNTIME_EVENT_TYPES = {
  ORDER_CREATED: "order.created",
  ORDER_ITEMS_ADDED: "order.items_added",
  ORDER_ITEM_CANCELLED: "order.item_cancelled",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_ITEMS_TRANSFERRED: "order.items_transferred",
  ORDER_VOIDED: "order.voided",
  KOT_SENT: "kot.sent",
  KOT_CANCELLED: "kot.cancelled",
  BILL_REQUESTED: "bill.requested",
  BILL_GENERATED: "bill.generated",
  BILL_EDITED: "bill.edited",
  PAYMENT_RECORDED: "payment.recorded",
  ORDER_SETTLED: "settlement.order_settled",
  SETTLEMENT_VOIDED: "settlement.voided",
  SHIFT_OPENED: "shift.opened",
  SHIFT_CLOSED: "shift.closed",
  TABLE_SESSION_OPENED: "table_session.opened",
  TABLE_SESSION_CLOSED: "table_session.closed",
  TABLE_STATUS_CHANGED: "table.status_changed",
  TABLE_SWAPPED: "table.swapped",
  CUSTOMER_CREATED: "customer.created",
  CUSTOMER_ATTACHED: "customer.attached",
  INVENTORY_DEDUCTED: "inventory.deducted",
  INVENTORY_RESTORED: "inventory.restored",
  INVENTORY_ADJUSTED: "inventory.adjusted",
} as const;

const RUNTIME_EVENT_TYPE_SET: Set<string> = new Set(Object.values(RUNTIME_EVENT_TYPES));

const RUNTIME_EVENT_AGGREGATE: Record<string, string> = {
  [RUNTIME_EVENT_TYPES.ORDER_CREATED]: "order",
  [RUNTIME_EVENT_TYPES.ORDER_ITEMS_ADDED]: "order",
  [RUNTIME_EVENT_TYPES.ORDER_ITEM_CANCELLED]: "order",
  [RUNTIME_EVENT_TYPES.ORDER_STATUS_CHANGED]: "order",
  [RUNTIME_EVENT_TYPES.ORDER_ITEMS_TRANSFERRED]: "order",
  [RUNTIME_EVENT_TYPES.ORDER_VOIDED]: "order",
  [RUNTIME_EVENT_TYPES.KOT_SENT]: "kot",
  [RUNTIME_EVENT_TYPES.KOT_CANCELLED]: "kot",
  [RUNTIME_EVENT_TYPES.BILL_REQUESTED]: "bill",
  [RUNTIME_EVENT_TYPES.BILL_GENERATED]: "bill",
  [RUNTIME_EVENT_TYPES.BILL_EDITED]: "bill",
  [RUNTIME_EVENT_TYPES.PAYMENT_RECORDED]: "payment",
  [RUNTIME_EVENT_TYPES.ORDER_SETTLED]: "settlement",
  [RUNTIME_EVENT_TYPES.SETTLEMENT_VOIDED]: "settlement",
  [RUNTIME_EVENT_TYPES.SHIFT_OPENED]: "shift",
  [RUNTIME_EVENT_TYPES.SHIFT_CLOSED]: "shift",
  [RUNTIME_EVENT_TYPES.TABLE_SESSION_OPENED]: "table_session",
  [RUNTIME_EVENT_TYPES.TABLE_SESSION_CLOSED]: "table_session",
  [RUNTIME_EVENT_TYPES.TABLE_STATUS_CHANGED]: "table",
  [RUNTIME_EVENT_TYPES.TABLE_SWAPPED]: "table",
  [RUNTIME_EVENT_TYPES.CUSTOMER_CREATED]: "customer",
  [RUNTIME_EVENT_TYPES.CUSTOMER_ATTACHED]: "customer",
  [RUNTIME_EVENT_TYPES.INVENTORY_DEDUCTED]: "inventory",
  [RUNTIME_EVENT_TYPES.INVENTORY_RESTORED]: "inventory",
  [RUNTIME_EVENT_TYPES.INVENTORY_ADJUSTED]: "inventory",
};

export interface RuntimeEventEnvelope {
  eventId: string;
  envelopeVersion: number;
  schemaVersion: number;
  restaurantId: string;
  runtimeId?: string | null;
  origin: "runtime";
  aggregate: string;
  aggregateId: string;
  eventType: string;
  actorId?: string | null;
  actorRole?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
  occurredAt: number;
  payload: Record<string, unknown>;
}

export interface RuntimeEventIngestResult {
  eventId: string;
  outcome: "applied" | "duplicate" | "rejected" | "retry";
  code?: string;
  message?: string;
  cloudSeq?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new RuntimeEventError("MALFORMED_PAYLOAD", `${field} must be a non-empty string <= 256 characters`);
  }
  return value;
}

function parseEnvelope(raw: unknown, restaurantId: string): RuntimeEventEnvelope {
  if (!isRecord(raw)) throw new RuntimeEventError("MALFORMED_PAYLOAD", "Event must be a JSON object");

  const eventId = requireString(raw.eventId, "eventId");
  const eventRestaurantId = requireString(raw.restaurantId, "restaurantId");
  if (eventRestaurantId !== restaurantId) {
    throw new RuntimeEventError("TENANT_MISMATCH", "Event restaurantId does not match authenticated outlet");
  }

  if (raw.origin !== "runtime") {
    throw new RuntimeEventError("OWNERSHIP_VIOLATION", "Cloud ingest accepts runtime-origin events only");
  }

  const eventType = requireString(raw.eventType, "eventType");
  if (!RUNTIME_EVENT_TYPE_SET.has(eventType)) {
    throw new RuntimeEventError("UNKNOWN_EVENT_TYPE", `Unsupported Runtime event type '${eventType}'`);
  }

  const aggregate = requireString(raw.aggregate, "aggregate");
  const aggregateId = requireString(raw.aggregateId, "aggregateId");
  if (RUNTIME_EVENT_AGGREGATE[eventType] !== aggregate) {
    throw new RuntimeEventError("VALIDATION_FAILED", `Event type '${eventType}' must target aggregate '${RUNTIME_EVENT_AGGREGATE[eventType]}'`);
  }
  const schemaVersion = Number(raw.schemaVersion ?? 1);
  const envelopeVersion = Number(raw.envelopeVersion ?? 1);
  const occurredAt = Number(raw.occurredAt);
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 1) {
    throw new RuntimeEventError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported event schemaVersion");
  }
  if (!Number.isSafeInteger(envelopeVersion) || envelopeVersion !== 1) {
    throw new RuntimeEventError("UNSUPPORTED_SCHEMA_VERSION", "Unsupported event envelopeVersion");
  }
  if (!Number.isFinite(occurredAt)) {
    throw new RuntimeEventError("MALFORMED_PAYLOAD", "occurredAt must be a finite number");
  }
  if (!isRecord(raw.payload)) {
    throw new RuntimeEventError("MALFORMED_PAYLOAD", "payload must be a JSON object");
  }

  const optionalString = (field: string): string | null => {
    const value = raw[field];
    if (value === undefined || value === null) return null;
    return requireString(value, field);
  };

  return {
    eventId,
    envelopeVersion,
    schemaVersion,
    restaurantId,
    runtimeId: optionalString("runtimeId"),
    origin: "runtime",
    aggregate,
    aggregateId,
    eventType,
    actorId: optionalString("actorId"),
    actorRole: optionalString("actorRole"),
    requestId: optionalString("requestId"),
    correlationId: optionalString("correlationId"),
    causationId: optionalString("causationId"),
    occurredAt,
    payload: raw.payload,
  };
}

export class RuntimeEventError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeEventError";
  }
}

function toJsonDate(epochMs: number): Date {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) throw new RuntimeEventError("MALFORMED_PAYLOAD", "occurredAt is invalid");
  return date;
}

export async function ingestRuntimeEvents(
  restaurantId: string,
  rawEvents: unknown[],
): Promise<RuntimeEventIngestResult[]> {
  if (rawEvents.length > 100) {
    throw new RuntimeEventError("VALIDATION_FAILED", "A Runtime event batch may contain at most 100 events");
  }

  const results: RuntimeEventIngestResult[] = [];
  for (const raw of rawEvents) {
    let event: RuntimeEventEnvelope;
    try {
      event = parseEnvelope(raw, restaurantId);
    } catch (error) {
      const runtimeError = error instanceof RuntimeEventError
        ? error
        : new RuntimeEventError("INTERNAL_ERROR", "Event validation failed");
      const rawRecord = isRecord(raw) ? raw : {};
      const eventId = typeof rawRecord.eventId === "string" ? rawRecord.eventId : null;
      await prisma.runtimeEventDeadLetter.create({
        data: {
          eventId,
          restaurantId,
          reasonCode: runtimeError.code,
          reason: runtimeError.message,
          failureClass: "PERMANENT",
          payload: raw as Prisma.InputJsonValue,
        },
      });
      results.push({ eventId: eventId ?? "unknown", outcome: "rejected", code: runtimeError.code, message: runtimeError.message });
      continue;
    }

    try {
      if (!hasCloudProjection(event.eventType)) {
        await prisma.runtimeEventDeadLetter.create({
          data: {
            eventId: event.eventId,
            restaurantId,
            runtimeId: event.runtimeId,
            aggregate: event.aggregate,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            requestId: event.requestId,
            reasonCode: "PROJECTION_NOT_REGISTERED",
            reason: `No cloud projection registered for '${event.eventType}'`,
            failureClass: "PERMANENT",
            payload: event.payload as Prisma.InputJsonValue,
          },
        });
        results.push({
          eventId: event.eventId,
          outcome: "rejected",
          code: "PROJECTION_NOT_REGISTERED",
          message: `No cloud projection registered for '${event.eventType}'`,
        });
        continue;
      }

      const inserted = await prisma.$transaction(async (tx) => {
        const created = await tx.runtimeEvent.create({
          data: {
            eventId: event.eventId,
            envelopeVersion: event.envelopeVersion,
            schemaVersion: event.schemaVersion,
            restaurantId,
            runtimeId: event.runtimeId,
            origin: event.origin,
            aggregate: event.aggregate,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            actorId: event.actorId,
            actorRole: event.actorRole,
            requestId: event.requestId,
            correlationId: event.correlationId,
            causationId: event.causationId,
            payload: event.payload as Prisma.InputJsonValue,
            occurredAt: toJsonDate(event.occurredAt),
          },
          select: { cloudSequence: true },
        });

        await dispatchCloudProjection(tx as unknown as Prisma.TransactionClient, event);
        return created;
      });

      results.push({ eventId: event.eventId, outcome: "applied", cloudSeq: inserted.cloudSequence.toString() });
    } catch (error: any) {
      if (error?.code === "P2002") {
        results.push({ eventId: event.eventId, outcome: "duplicate" });
        continue;
      }

      // Do not claim a retryable outcome for unknown database errors without
      // knowing whether the write committed. A unique eventId makes a retry safe;
      // the caller will reconcile it as duplicate if it did commit.
      results.push({ eventId: event.eventId, outcome: "retry", code: "CLOUD_UNAVAILABLE", message: "Event ingest temporarily unavailable" });
    }
  }

  return results;
}

export async function getRuntimeChanges(
  restaurantId: string,
  cursor: bigint,
  limit: number,
): Promise<{
  events: Array<Record<string, unknown>>;
  nextCursor: string;
  hasMore: boolean;
}> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const rows = await prisma.runtimeEvent.findMany({
    // Runtime changes are cloud-originated configuration only. Uploaded
    // operational events are deliberately not echoed back to their source.
    where: { restaurantId, origin: "cloud", cloudSequence: { gt: cursor } },
    orderBy: { cloudSequence: "asc" },
    take: safeLimit,
  });

  const nextCursor = rows.length > 0 ? rows[rows.length - 1].cloudSequence : cursor;
  return {
    events: rows.map((row) => ({
      eventId: row.eventId,
      envelopeVersion: row.envelopeVersion,
      schemaVersion: row.schemaVersion,
      restaurantId: row.restaurantId,
      runtimeId: row.runtimeId,
      origin: "cloud",
      aggregate: row.aggregate,
      aggregateId: row.aggregateId,
      eventType: row.eventType,
      actorId: row.actorId,
      actorRole: row.actorRole,
      requestId: row.requestId,
      correlationId: row.correlationId,
      causationId: row.causationId,
      occurredAt: row.occurredAt.getTime(),
      payload: row.payload,
      cloudSequence: row.cloudSequence.toString(),
    })),
    nextCursor: nextCursor.toString(),
    hasMore: rows.length === safeLimit,
  };
}

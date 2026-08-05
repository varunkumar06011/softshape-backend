-- Runtime v2: immutable cloud event log and dead-letter records.
-- The event log uses a global BIGSERIAL cursor. Runtime clients filter by
-- restaurant_id while advancing the global cursor monotonically.

CREATE TABLE "RuntimeEvent" (
    "id" TEXT NOT NULL,
    "cloudSequence" BIGSERIAL NOT NULL,
    "eventId" TEXT NOT NULL,
    "envelopeVersion" INTEGER NOT NULL DEFAULT 1,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "restaurantId" TEXT NOT NULL,
    "runtimeId" TEXT,
    "origin" TEXT NOT NULL,
    "aggregate" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorRole" TEXT,
    "requestId" TEXT,
    "correlationId" TEXT,
    "causationId" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RuntimeEvent_cloudSequence_key" ON "RuntimeEvent"("cloudSequence");
CREATE UNIQUE INDEX "RuntimeEvent_eventId_key" ON "RuntimeEvent"("eventId");
CREATE UNIQUE INDEX "RuntimeEvent_restaurantId_eventId_key" ON "RuntimeEvent"("restaurantId", "eventId");
CREATE INDEX "RuntimeEvent_restaurantId_cloudSequence_idx" ON "RuntimeEvent"("restaurantId", "cloudSequence");
CREATE INDEX "RuntimeEvent_restaurantId_aggregate_aggregateId_cloudSequence_idx"
  ON "RuntimeEvent"("restaurantId", "aggregate", "aggregateId", "cloudSequence");
CREATE INDEX "RuntimeEvent_eventType_cloudSequence_idx" ON "RuntimeEvent"("eventType", "cloudSequence");

CREATE TABLE "RuntimeEventDeadLetter" (
    "id" TEXT NOT NULL,
    "eventId" TEXT,
    "restaurantId" TEXT NOT NULL,
    "runtimeId" TEXT,
    "aggregate" TEXT,
    "aggregateId" TEXT,
    "eventType" TEXT,
    "requestId" TEXT,
    "reasonCode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "failureClass" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeEventDeadLetter_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RuntimeEventDeadLetter_restaurantId_resolved_createdAt_idx"
  ON "RuntimeEventDeadLetter"("restaurantId", "resolved", "createdAt");
CREATE INDEX "RuntimeEventDeadLetter_eventId_idx" ON "RuntimeEventDeadLetter"("eventId");

-- CreateEnum
CREATE TYPE "IntegrationHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'FAILING');

-- CreateEnum
CREATE TYPE "IntegrationSecretSlot" AS ENUM ('CURRENT', 'PREVIOUS');

-- CreateEnum
CREATE TYPE "ExternalEntityType" AS ENUM ('PRODUCT', 'ORDER');

-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'DEAD');

-- CreateEnum
CREATE TYPE "IntegrationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "IntegrationDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "publicId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "outboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "disabledReason" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "grants" TEXT[],
    "serviceUserId" UUID NOT NULL,
    "healthStatus" "IntegrationHealth" NOT NULL DEFAULT 'HEALTHY',
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastFailureAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastErrorSummary" TEXT,
    "outboundPausedAt" TIMESTAMPTZ(3),
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSecret" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slot" "IntegrationSecretSlot" NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "keyId" TEXT NOT NULL,
    "rotatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalRef" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "entityType" "ExternalEntityType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "productId" UUID,
    "orderId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "InboundEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMPTZ(3),
    "resultType" TEXT,
    "resultId" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "correlationId" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "seq" BIGSERIAL NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "fannedOutAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationDelivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "outboxEventId" UUID NOT NULL,
    "status" "IntegrationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastHttpStatus" INTEGER,
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "deliveredAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IntegrationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "integrationId" UUID NOT NULL,
    "direction" "IntegrationDirection" NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT,
    "eventType" TEXT,
    "inboundEventId" UUID,
    "deliveryId" UUID,
    "correlationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "httpStatus" INTEGER,
    "durationMs" INTEGER,
    "safeSummary" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Integration_publicId_key" ON "Integration"("publicId");

-- CreateIndex
CREATE INDEX "Integration_organizationId_enabled_idx" ON "Integration"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_id_key" ON "Integration"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_organizationId_name_key" ON "Integration"("organizationId", "name");

-- CreateIndex
CREATE INDEX "IntegrationSecret_organizationId_integrationId_idx" ON "IntegrationSecret"("organizationId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSecret_integrationId_name_slot_key" ON "IntegrationSecret"("integrationId", "name", "slot");

-- CreateIndex
CREATE INDEX "ExternalRef_organizationId_productId_idx" ON "ExternalRef"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "ExternalRef_organizationId_orderId_idx" ON "ExternalRef"("organizationId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_integrationId_entityType_externalId_key" ON "ExternalRef"("integrationId", "entityType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_integrationId_productId_key" ON "ExternalRef"("integrationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_integrationId_orderId_key" ON "ExternalRef"("integrationId", "orderId");

-- CreateIndex
CREATE INDEX "InboundEvent_organizationId_integrationId_status_idx" ON "InboundEvent"("organizationId", "integrationId", "status");

-- CreateIndex
CREATE INDEX "InboundEvent_organizationId_integrationId_receivedAt_idx" ON "InboundEvent"("organizationId", "integrationId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_organizationId_id_key" ON "InboundEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InboundEvent_organizationId_integrationId_externalEventId_key" ON "InboundEvent"("organizationId", "integrationId", "externalEventId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_seq_key" ON "OutboxEvent"("seq");

-- CreateIndex
CREATE INDEX "OutboxEvent_organizationId_eventType_idx" ON "OutboxEvent"("organizationId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_organizationId_id_key" ON "OutboxEvent"("organizationId", "id");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_organizationId_integrationId_status_idx" ON "IntegrationDelivery"("organizationId", "integrationId", "status");

-- CreateIndex
CREATE INDEX "IntegrationDelivery_outboxEventId_idx" ON "IntegrationDelivery"("outboxEventId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationDelivery_organizationId_id_key" ON "IntegrationDelivery"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationDelivery_integrationId_outboxEventId_key" ON "IntegrationDelivery"("integrationId", "outboxEventId");

-- CreateIndex
CREATE INDEX "IntegrationLog_organizationId_integrationId_createdAt_idx" ON "IntegrationLog"("organizationId", "integrationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_serviceUserId_fkey" FOREIGN KEY ("serviceUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "Integration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "Integration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "Integration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "Integration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_organizationId_outboxEventId_fkey" FOREIGN KEY ("organizationId", "outboxEventId") REFERENCES "OutboxEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationLog" ADD CONSTRAINT "IntegrationLog_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "Integration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===================================================================================================
-- Hand-written part (Phase 6): CHECK constraints, partial indexes, triggers, role permissions.
-- This migration is purely additive: it creates new objects and changes no existing table or data
-- except appending two permission names to the built-in Owner/Admin roles.
-- ===================================================================================================

-- Integration ----------------------------------------------------------------------------------------
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_shape_check" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND "publicId" ~ '^[A-Za-z0-9_-]{22,64}$'
  AND "provider" ~ '^[a-z0-9][a-z0-9-]{0,39}$'
  AND "consecutiveFailures" >= 0
  AND ("disabledReason" IS NULL OR char_length("disabledReason") <= 200)
  AND ("lastErrorSummary" IS NULL OR char_length("lastErrorSummary") <= 300)
);
-- Database backstop for the actor's blast radius: an integration can only ever be granted these two
-- permissions (never inventory.*, warehouse.*, picking.manage or packing.manage).
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_grants_check"
  CHECK ("grants" <@ ARRAY['products.manage', 'orders.manage']::text[]);
-- An archived integration can never be enabled, so it cannot process events.
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_archived_disabled_check"
  CHECK (NOT ("enabled" AND "archivedAt" IS NOT NULL));

-- IntegrationSecret ----------------------------------------------------------------------------------
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_shape_check" CHECK (
  "name" ~ '^[a-z][a-z0-9_]{0,39}$'
  AND octet_length("iv") = 12
  AND octet_length("authTag") = 16
  AND octet_length("ciphertext") BETWEEN 1 AND 4096
  AND "keyId" ~ '^[A-Za-z0-9_-]{1,32}$'
);

-- ExternalRef: exactly one typed FK is set and it matches entityType ----------------------------------
ALTER TABLE "ExternalRef" ADD CONSTRAINT "ExternalRef_entity_check" CHECK (
  char_length("externalId") BETWEEN 1 AND 200
  AND (
    ("entityType" = 'PRODUCT' AND "productId" IS NOT NULL AND "orderId" IS NULL)
    OR ("entityType" = 'ORDER' AND "orderId" IS NOT NULL AND "productId" IS NULL)
  )
);

-- InboundEvent ---------------------------------------------------------------------------------------
ALTER TABLE "InboundEvent" ADD CONSTRAINT "InboundEvent_shape_check" CHECK (
  char_length("externalEventId") BETWEEN 1 AND 128
  AND char_length("eventType") BETWEEN 1 AND 64
  AND "payloadHash" ~ '^[0-9a-f]{64}$'
  AND "attempts" >= 0
  AND octet_length("payload"::text) <= 262144
  AND ("lastErrorSummary" IS NULL OR char_length("lastErrorSummary") <= 300)
  -- A lease exists exactly while the event is being processed.
  AND (("status" = 'PROCESSING') = ("lockedUntil" IS NOT NULL))
);
CREATE INDEX "InboundEvent_claim_idx" ON "InboundEvent" ("nextAttemptAt") WHERE "status" IN ('RECEIVED', 'FAILED');
CREATE INDEX "InboundEvent_lease_idx" ON "InboundEvent" ("lockedUntil") WHERE "status" = 'PROCESSING';

-- OutboxEvent ----------------------------------------------------------------------------------------
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_shape_check" CHECK (
  "eventType" ~ '^[a-z]+(\.[a-z_]+)+$'
  AND char_length("eventType") <= 64
  AND "schemaVersion" >= 1
  AND octet_length("payload"::text) <= 262144
);
CREATE INDEX "OutboxEvent_unfanned_idx" ON "OutboxEvent" ("seq") WHERE "fannedOutAt" IS NULL;
CREATE INDEX "OutboxEvent_purge_idx" ON "OutboxEvent" ("fannedOutAt") WHERE "fannedOutAt" IS NOT NULL;

-- An outbox event is immutable once written; only the one-time fan-out marker may be set.
CREATE FUNCTION outbox_event_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."seq" IS DISTINCT FROM OLD."seq"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."eventType" IS DISTINCT FROM OLD."eventType"
     OR NEW."schemaVersion" IS DISTINCT FROM OLD."schemaVersion"
     OR NEW."occurredAt" IS DISTINCT FROM OLD."occurredAt"
     OR NEW."payload" IS DISTINCT FROM OLD."payload"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."fannedOutAt" IS NOT NULL AND NEW."fannedOutAt" IS DISTINCT FROM OLD."fannedOutAt") THEN
    RAISE EXCEPTION '% is immutable: only the fan-out marker may be set once', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OutboxEvent_immutable" BEFORE UPDATE ON "OutboxEvent"
  FOR EACH ROW EXECUTE FUNCTION outbox_event_is_immutable();

-- IntegrationDelivery --------------------------------------------------------------------------------
ALTER TABLE "IntegrationDelivery" ADD CONSTRAINT "IntegrationDelivery_shape_check" CHECK (
  "attempts" >= 0
  AND ("lastErrorSummary" IS NULL OR char_length("lastErrorSummary") <= 300)
  AND (("status" = 'PROCESSING') = ("lockedUntil" IS NOT NULL))
  AND ("status" <> 'SUCCEEDED' OR "deliveredAt" IS NOT NULL)
);
CREATE INDEX "IntegrationDelivery_claim_idx" ON "IntegrationDelivery" ("nextAttemptAt") WHERE "status" IN ('PENDING', 'FAILED');
CREATE INDEX "IntegrationDelivery_lease_idx" ON "IntegrationDelivery" ("lockedUntil") WHERE "status" = 'PROCESSING';

-- IntegrationLog: safe summaries only, append-only ---------------------------------------------------
ALTER TABLE "IntegrationLog" ADD CONSTRAINT "IntegrationLog_shape_check" CHECK (
  "status" IN ('RECEIVED', 'DUPLICATE', 'CONFLICT', 'SUCCEEDED', 'RETRY_SCHEDULED', 'REJECTED', 'DEAD',
               'REPLAYED', 'PAUSED', 'RESUMED', 'TEST_SUCCEEDED', 'TEST_FAILED', 'LEASE_EXPIRED')
  AND char_length("safeSummary") <= 300
  AND "attempt" >= 0
  AND ("durationMs" IS NULL OR "durationMs" >= 0)
);

CREATE FUNCTION integration_log_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IntegrationLog_append_only" BEFORE UPDATE OR DELETE ON "IntegrationLog"
  FOR EACH ROW EXECUTE FUNCTION integration_log_is_append_only();

-- Data migration: new permissions for the built-in Owner/Admin roles that already exist ---------------
-- (Members get none: integration logs and payloads can contain business data.)
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['integrations.view', 'integrations.manage']))
  WHERE "isSystem" AND "name" IN ('Owner', 'Admin');

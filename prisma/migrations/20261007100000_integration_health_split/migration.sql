-- Phase 6 correction: inbound and outbound health are tracked independently.
-- The existing (mixed) columns become the INBOUND columns; five new OUTBOUND columns are added.
-- The circuit breaker (outboundPausedAt) depends on the outbound counter only.
-- No data is lost: existing values are carried into the direction(s) the integration actually uses.

ALTER TABLE "Integration" ADD COLUMN "outboundHealthStatus" "IntegrationHealth" NOT NULL DEFAULT 'HEALTHY';
ALTER TABLE "Integration" ADD COLUMN "outboundLastSuccessAt" TIMESTAMPTZ(3);
ALTER TABLE "Integration" ADD COLUMN "outboundLastFailureAt" TIMESTAMPTZ(3);
ALTER TABLE "Integration" ADD COLUMN "outboundConsecutiveFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Integration" ADD COLUMN "outboundLastErrorSummary" TEXT;

-- Outbound-enabled integrations: the old combined values become their outbound health.
UPDATE "Integration" SET
  "outboundHealthStatus" = "healthStatus",
  "outboundLastSuccessAt" = "lastSuccessAt",
  "outboundLastFailureAt" = "lastFailureAt",
  "outboundConsecutiveFailures" = "consecutiveFailures",
  "outboundLastErrorSummary" = "lastErrorSummary"
WHERE "outboundEnabled";
-- Integrations without inbound start with a clean inbound record.
UPDATE "Integration" SET
  "healthStatus" = 'HEALTHY', "lastSuccessAt" = NULL, "lastFailureAt" = NULL, "consecutiveFailures" = 0, "lastErrorSummary" = NULL
WHERE NOT "inboundEnabled";

ALTER TABLE "Integration" RENAME COLUMN "healthStatus" TO "inboundHealthStatus";
ALTER TABLE "Integration" RENAME COLUMN "lastSuccessAt" TO "inboundLastSuccessAt";
ALTER TABLE "Integration" RENAME COLUMN "lastFailureAt" TO "inboundLastFailureAt";
ALTER TABLE "Integration" RENAME COLUMN "consecutiveFailures" TO "inboundConsecutiveFailures";
ALTER TABLE "Integration" RENAME COLUMN "lastErrorSummary" TO "inboundLastErrorSummary";

-- Recreate the shape CHECK with the new column names (and the outbound counterparts).
ALTER TABLE "Integration" DROP CONSTRAINT "Integration_shape_check";
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_shape_check" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND "publicId" ~ '^[A-Za-z0-9_-]{22,64}$'
  AND "provider" ~ '^[a-z0-9][a-z0-9-]{0,39}$'
  AND "inboundConsecutiveFailures" >= 0
  AND "outboundConsecutiveFailures" >= 0
  AND ("disabledReason" IS NULL OR char_length("disabledReason") <= 200)
  AND ("inboundLastErrorSummary" IS NULL OR char_length("inboundLastErrorSummary") <= 300)
  AND ("outboundLastErrorSummary" IS NULL OR char_length("outboundLastErrorSummary") <= 300)
);

-- CreateEnum
CREATE TYPE "PackingSessionStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PackageStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PackingEventType" AS ENUM ('SESSION_STARTED', 'PACKAGE_CREATED', 'PACKAGE_UPDATED', 'ITEM_ADDED', 'ITEM_CHANGED', 'ITEM_REMOVED', 'PACKAGE_COMPLETED', 'PACKAGE_CANCELLED', 'SESSION_COMPLETED', 'SESSION_CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderStatus" ADD VALUE 'PACKING';
ALTER TYPE "OrderStatus" ADD VALUE 'PACKED';

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "packedQty" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PackingSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "status" "PackingSessionStatus" NOT NULL DEFAULT 'OPEN',
    "startedByUserId" UUID,
    "completedByUserId" UUID,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PackingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "packageNumber" INTEGER NOT NULL,
    "status" "PackageStatus" NOT NULL DEFAULT 'OPEN',
    "packageType" TEXT,
    "weightG" INTEGER,
    "lengthMm" INTEGER,
    "widthMm" INTEGER,
    "heightMm" INTEGER,
    "completedByUserId" UUID,
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackingEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "type" "PackingEventType" NOT NULL,
    "packageId" UUID,
    "orderLineId" UUID,
    "productId" UUID,
    "quantityDelta" INTEGER,
    "quantityAfter" INTEGER,
    "detail" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PackingSession_organizationId_status_idx" ON "PackingSession"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PackingSession_orderId_idx" ON "PackingSession"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PackingSession_organizationId_id_key" ON "PackingSession"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PackingSession_organizationId_id_orderId_key" ON "PackingSession"("organizationId", "id", "orderId");

-- CreateIndex
CREATE INDEX "Package_organizationId_status_idx" ON "Package"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Package_sessionId_idx" ON "Package"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_organizationId_id_key" ON "Package"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Package_organizationId_id_orderId_key" ON "Package"("organizationId", "id", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Package_orderId_packageNumber_key" ON "Package"("orderId", "packageNumber");

-- CreateIndex
CREATE INDEX "PackageItem_orderLineId_idx" ON "PackageItem"("orderLineId");

-- CreateIndex
CREATE INDEX "PackageItem_organizationId_productId_idx" ON "PackageItem"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "PackageItem_organizationId_id_key" ON "PackageItem"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PackageItem_packageId_orderLineId_key" ON "PackageItem"("packageId", "orderLineId");

-- CreateIndex
CREATE INDEX "PackingEvent_organizationId_sessionId_createdAt_idx" ON "PackingEvent"("organizationId", "sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "PackingEvent_packageId_idx" ON "PackingEvent"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_organizationId_scope_key_key" ON "IdempotencyRecord"("organizationId", "scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_organizationId_orderId_id_productId_key" ON "OrderLine"("organizationId", "orderId", "id", "productId");

-- AddForeignKey
ALTER TABLE "PackingSession" ADD CONSTRAINT "PackingSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingSession" ADD CONSTRAINT "PackingSession_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingSession" ADD CONSTRAINT "PackingSession_startedByUserId_fkey" FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingSession" ADD CONSTRAINT "PackingSession_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_organizationId_sessionId_orderId_fkey" FOREIGN KEY ("organizationId", "sessionId", "orderId") REFERENCES "PackingSession"("organizationId", "id", "orderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_organizationId_packageId_orderId_fkey" FOREIGN KEY ("organizationId", "packageId", "orderId") REFERENCES "Package"("organizationId", "id", "orderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_organizationId_orderId_orderLineId_productId_fkey" FOREIGN KEY ("organizationId", "orderId", "orderLineId", "productId") REFERENCES "OrderLine"("organizationId", "orderId", "id", "productId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingEvent" ADD CONSTRAINT "PackingEvent_organizationId_sessionId_fkey" FOREIGN KEY ("organizationId", "sessionId") REFERENCES "PackingSession"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackingEvent" ADD CONSTRAINT "PackingEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints, triggers and data migration (Prisma cannot express these).
-- NOTE: ALTER TYPE ... ADD VALUE ("OrderStatus" PACKING / PACKED) cannot be USED in this transaction;
-- nothing below mentions those values. Enum columns are compared through ::text where it matters.
-- Packing never references inventory tables: no FK, no constraint, no trigger touches them.
-- ---------------------------------------------------------------------------

-- At most ONE open packing session per order: the database is the final backstop against two
-- workers starting packing for the same order at the same time.
CREATE UNIQUE INDEX "PackingSession_one_open_per_order_idx"
  ON "PackingSession" ("orderId")
  WHERE "status" = 'OPEN';

ALTER TABLE "PackingSession" ADD CONSTRAINT "PackingSession_status_check" CHECK (
  ("status"::text <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status"::text <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
);

-- The core fulfilment invariant: you can never have packed more than you picked.
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_packed_check"
  CHECK ("packedQty" >= 0 AND "packedQty" <= "pickedQty");

-- Packages: positive integer measures when supplied (grams / millimetres); dimensions come as a set.
ALTER TABLE "Package" ADD CONSTRAINT "Package_number_check" CHECK ("packageNumber" >= 1);
ALTER TABLE "Package" ADD CONSTRAINT "Package_measures_check" CHECK (
  ("weightG" IS NULL OR ("weightG" > 0 AND "weightG" <= 1000000000))
  AND ("lengthMm" IS NULL OR ("lengthMm" > 0 AND "lengthMm" <= 100000))
  AND ("widthMm" IS NULL OR ("widthMm" > 0 AND "widthMm" <= 100000))
  AND ("heightMm" IS NULL OR ("heightMm" > 0 AND "heightMm" <= 100000))
  AND (("lengthMm" IS NULL) = ("widthMm" IS NULL) AND ("widthMm" IS NULL) = ("heightMm" IS NULL))
  AND ("packageType" IS NULL OR char_length("packageType") BETWEEN 1 AND 40)
);
ALTER TABLE "Package" ADD CONSTRAINT "Package_status_check" CHECK (
  ("status"::text <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  AND ("status"::text <> 'CANCELLED' OR "cancelledAt" IS NOT NULL)
);

ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_quantity_check"
  CHECK ("quantity" > 0 AND "quantity" <= 100000000);

ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_shape_check"
  CHECK (char_length("scope") BETWEEN 1 AND 80 AND char_length("key") BETWEEN 8 AND 100);

-- The packing audit trail is append-only.
CREATE FUNCTION packing_event_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PackingEvent_append_only" BEFORE UPDATE OR DELETE ON "PackingEvent"
  FOR EACH ROW EXECUTE FUNCTION packing_event_is_append_only();

-- Data migration: new permissions for the built-in roles that already exist (nothing is removed).
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['packing.view', 'packing.manage']))
  WHERE "isSystem" AND "name" IN ('Owner', 'Admin');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['packing.view']))
  WHERE "isSystem" AND "name" = 'Member';

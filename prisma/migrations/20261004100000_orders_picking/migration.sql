-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'READY', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'PICKING', 'PICKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaveStatus" AS ENUM ('DRAFT', 'RELEASED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PickTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'PICK';

-- AlterEnum
ALTER TYPE "ReservationStatus" ADD VALUE 'CONSUMED';

-- AlterTable
ALTER TABLE "Reservation" ADD COLUMN     "consumedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "ReservationLine" ADD COLUMN     "consumedQuantity" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "externalRef" TEXT,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productId" UUID NOT NULL,
    "requestedQty" INTEGER NOT NULL,
    "allocatedQty" INTEGER NOT NULL DEFAULT 0,
    "pickedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickingWave" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "WaveStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "releasedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),

    CONSTRAINT "PickingWave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PickTask" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "waveId" UUID,
    "orderId" UUID NOT NULL,
    "orderLineId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "positionCode" TEXT NOT NULL,
    "reservationId" UUID NOT NULL,
    "reservationLineId" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pickedQty" INTEGER NOT NULL DEFAULT 0,
    "status" "PickTaskStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PickTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Order_organizationId_status_idx" ON "Order"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Order_organizationId_createdAt_idx" ON "Order"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_id_key" ON "Order"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_organizationId_orderNumber_key" ON "Order"("organizationId", "orderNumber");

-- CreateIndex
CREATE INDEX "OrderLine_organizationId_productId_idx" ON "OrderLine"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_lineNo_key" ON "OrderLine"("orderId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_productId_key" ON "OrderLine"("orderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_organizationId_id_key" ON "OrderLine"("organizationId", "id");

-- CreateIndex
CREATE INDEX "PickingWave_organizationId_status_idx" ON "PickingWave"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PickingWave_organizationId_id_key" ON "PickingWave"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PickingWave_organizationId_number_key" ON "PickingWave"("organizationId", "number");

-- CreateIndex
CREATE INDEX "PickTask_organizationId_status_idx" ON "PickTask"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PickTask_organizationId_waveId_idx" ON "PickTask"("organizationId", "waveId");

-- CreateIndex
CREATE INDEX "PickTask_orderId_idx" ON "PickTask"("orderId");

-- CreateIndex
CREATE INDEX "PickTask_orderLineId_idx" ON "PickTask"("orderLineId");

-- CreateIndex
CREATE INDEX "PickTask_organizationId_productId_idx" ON "PickTask"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "PickTask_positionId_idx" ON "PickTask"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "PickTask_organizationId_id_key" ON "PickTask"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PickTask_organizationId_reservationLineId_key" ON "PickTask"("organizationId", "reservationLineId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationLine_organizationId_id_key" ON "ReservationLine"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickingWave" ADD CONSTRAINT "PickingWave_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickingWave" ADD CONSTRAINT "PickingWave_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_waveId_fkey" FOREIGN KEY ("organizationId", "waveId") REFERENCES "PickingWave"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_orderId_fkey" FOREIGN KEY ("organizationId", "orderId") REFERENCES "Order"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_orderLineId_fkey" FOREIGN KEY ("organizationId", "orderLineId") REFERENCES "OrderLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_reservationId_fkey" FOREIGN KEY ("organizationId", "reservationId") REFERENCES "Reservation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_organizationId_reservationLineId_fkey" FOREIGN KEY ("organizationId", "reservationLineId") REFERENCES "ReservationLine"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints and data migration (Prisma cannot express these).
-- NOTE: ALTER TYPE ... ADD VALUE above cannot be USED in the same transaction, so every
-- constraint below compares enum columns through ::text and never mentions the new values as
-- enum literals. (PICK / CONSUMED are first used by application code after this migration.)
-- ---------------------------------------------------------------------------

-- Movement ledger: replace the shape CHECK to cover PICK and to REJECT unknown types.
-- (The Phase 3 version had no ELSE branch, so a newly added type would have passed unchecked.)
-- PICK consumes reserved stock: on-hand and reserved fall by the same amount.
ALTER TABLE "InventoryMovement" DROP CONSTRAINT "InventoryMovement_shape_check";
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_shape_check" CHECK (
  "onHandAfter" >= 0 AND "reservedAfter" >= 0 AND "reservedAfter" <= "onHandAfter" AND
  CASE "type"::text
    WHEN 'RECEIVE'        THEN "qtyDelta" > 0 AND "reservedDelta" = 0
    WHEN 'MOVE'           THEN "qtyDelta" <> 0 AND "reservedDelta" = 0
    WHEN 'ADJUSTMENT_IN'  THEN "qtyDelta" > 0 AND "reservedDelta" = 0
    WHEN 'ADJUSTMENT_OUT' THEN "qtyDelta" < 0 AND "reservedDelta" = 0
    WHEN 'RESERVE'        THEN "qtyDelta" = 0 AND "reservedDelta" > 0
    WHEN 'RELEASE'        THEN "qtyDelta" = 0 AND "reservedDelta" < 0
    WHEN 'PICK'           THEN "qtyDelta" < 0 AND "reservedDelta" = "qtyDelta"
    ELSE false
  END
);

-- Reservation lines: consumption can never exceed the reserved quantity.
ALTER TABLE "ReservationLine" ADD CONSTRAINT "ReservationLine_consumed_check"
  CHECK ("consumedQuantity" >= 0 AND "consumedQuantity" <= "quantity");

-- Orders
ALTER TABLE "Order" ADD CONSTRAINT "Order_orderNumber_format_check"
  CHECK ("orderNumber" ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$');

-- Order lines: 0 <= picked <= allocated <= requested (the core fulfilment invariant)
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_quantities_check"
  CHECK ("lineNo" >= 1 AND "requestedQty" > 0 AND "requestedQty" <= 100000000
         AND "pickedQty" >= 0 AND "pickedQty" <= "allocatedQty" AND "allocatedQty" <= "requestedQty");

-- Waves
ALTER TABLE "PickingWave" ADD CONSTRAINT "PickingWave_number_check" CHECK ("number" >= 1);

-- Pick tasks: picked never exceeds the task quantity; status agrees with the quantities.
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_quantities_check"
  CHECK ("quantity" > 0 AND "pickedQty" >= 0 AND "pickedQty" <= "quantity");
ALTER TABLE "PickTask" ADD CONSTRAINT "PickTask_status_check"
  CHECK (("status"::text <> 'COMPLETED' OR "pickedQty" = "quantity")
     AND ("status"::text <> 'PENDING'   OR "pickedQty" = 0));

-- Data migration: new permissions for the built-in roles that already exist (nothing is removed).
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" ||
    ARRAY['orders.view', 'orders.manage', 'picking.view', 'picking.manage']))
  WHERE "isSystem" AND "name" IN ('Owner', 'Admin');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['orders.view', 'picking.view']))
  WHERE "isSystem" AND "name" = 'Member';

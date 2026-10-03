-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('RECEIVE', 'MOVE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RESERVE', 'RELEASE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBarcode" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "barcode" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductBarcode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryBalance" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "InventoryBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryOperation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "actorUserId" UUID,
    "reason" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "type" "InventoryMovementType" NOT NULL,
    "warehouseId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "positionCode" TEXT NOT NULL,
    "counterpartPositionId" UUID,
    "counterpartPositionCode" TEXT,
    "qtyDelta" INTEGER NOT NULL,
    "reservedDelta" INTEGER NOT NULL,
    "onHandAfter" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "refType" TEXT,
    "refId" TEXT,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationLine" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "reservationId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "positionCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ReservationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_organizationId_name_idx" ON "Product"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_id_key" ON "Product"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Product_organizationId_sku_key" ON "Product"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "ProductBarcode_productId_idx" ON "ProductBarcode"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductBarcode_organizationId_barcode_key" ON "ProductBarcode"("organizationId", "barcode");

-- CreateIndex
CREATE INDEX "InventoryBalance_organizationId_productId_idx" ON "InventoryBalance"("organizationId", "productId");

-- CreateIndex
CREATE INDEX "InventoryBalance_positionId_idx" ON "InventoryBalance"("positionId");

-- CreateIndex
CREATE INDEX "InventoryBalance_organizationId_warehouseId_idx" ON "InventoryBalance"("organizationId", "warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryBalance_organizationId_positionId_productId_key" ON "InventoryBalance"("organizationId", "positionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryOperation_organizationId_idempotencyKey_key" ON "InventoryOperation"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryOperation_organizationId_id_key" ON "InventoryOperation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_productId_createdAt_idx" ON "InventoryMovement"("organizationId", "productId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_positionId_createdAt_idx" ON "InventoryMovement"("organizationId", "positionId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryMovement_operationId_idx" ON "InventoryMovement"("operationId");

-- CreateIndex
CREATE INDEX "InventoryMovement_organizationId_createdAt_idx" ON "InventoryMovement"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Reservation_organizationId_status_idx" ON "Reservation"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_organizationId_id_key" ON "Reservation"("organizationId", "id");

-- CreateIndex
CREATE INDEX "ReservationLine_organizationId_productId_idx" ON "ReservationLine"("organizationId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationLine_reservationId_positionId_productId_key" ON "ReservationLine"("reservationId", "positionId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_organizationId_warehouseId_id_key" ON "Position"("organizationId", "warehouseId", "id");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_warehouseId_positionId_fkey" FOREIGN KEY ("organizationId", "warehouseId", "positionId") REFERENCES "Position"("organizationId", "warehouseId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryOperation" ADD CONSTRAINT "InventoryOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryOperation" ADD CONSTRAINT "InventoryOperation_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_operationId_fkey" FOREIGN KEY ("organizationId", "operationId") REFERENCES "InventoryOperation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationLine" ADD CONSTRAINT "ReservationLine_organizationId_reservationId_fkey" FOREIGN KEY ("organizationId", "reservationId") REFERENCES "Reservation"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationLine" ADD CONSTRAINT "ReservationLine_organizationId_productId_fkey" FOREIGN KEY ("organizationId", "productId") REFERENCES "Product"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints, triggers and data migration (Prisma cannot express these).
-- See docs/inventory.md and docs/database.md.
-- ---------------------------------------------------------------------------

-- Catalog -------------------------------------------------------------------
-- SKUs are stored uppercase; allowed characters keep them safe in codes, URLs and CSV.
ALTER TABLE "Product" ADD CONSTRAINT "Product_sku_format_check"
  CHECK ("sku" ~ '^[A-Z0-9][A-Z0-9._/-]{0,63}$');
ALTER TABLE "Product" ADD CONSTRAINT "Product_name_check" CHECK (char_length(btrim("name")) > 0);
ALTER TABLE "ProductBarcode" ADD CONSTRAINT "ProductBarcode_format_check"
  CHECK (char_length("barcode") BETWEEN 1 AND 128 AND "barcode" = btrim("barcode"));

-- Inventory balances: the final backstop against corrupt stock -----------------
ALTER TABLE "InventoryBalance" ADD CONSTRAINT "InventoryBalance_quantities_check"
  CHECK ("onHand" >= 0 AND "reserved" >= 0 AND "reserved" <= "onHand" AND "onHand" <= 1000000000);

ALTER TABLE "ReservationLine" ADD CONSTRAINT "ReservationLine_quantity_check" CHECK ("quantity" > 0);

-- Movements: each type has a fixed sign pattern, and the after-snapshots must be valid ---------
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_shape_check" CHECK (
  "onHandAfter" >= 0 AND "reservedAfter" >= 0 AND "reservedAfter" <= "onHandAfter" AND
  CASE "type"
    WHEN 'RECEIVE'        THEN "qtyDelta" > 0 AND "reservedDelta" = 0
    WHEN 'MOVE'           THEN "qtyDelta" <> 0 AND "reservedDelta" = 0
    WHEN 'ADJUSTMENT_IN'  THEN "qtyDelta" > 0 AND "reservedDelta" = 0
    WHEN 'ADJUSTMENT_OUT' THEN "qtyDelta" < 0 AND "reservedDelta" = 0
    WHEN 'RESERVE'        THEN "qtyDelta" = 0 AND "reservedDelta" > 0
    WHEN 'RELEASE'        THEN "qtyDelta" = 0 AND "reservedDelta" < 0
  END
);

-- Append-only: the audit ledger and its operation headers can never be changed or deleted. -------
CREATE FUNCTION inventory_ledger_is_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InventoryMovement_append_only" BEFORE UPDATE OR DELETE ON "InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION inventory_ledger_is_append_only();
CREATE TRIGGER "InventoryOperation_append_only" BEFORE UPDATE OR DELETE ON "InventoryOperation"
  FOR EACH ROW EXECUTE FUNCTION inventory_ledger_is_append_only();

-- Data migration: new permissions for the built-in roles that already exist. --------------------
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" ||
    ARRAY['products.view', 'products.manage', 'inventory.view', 'inventory.adjust', 'inventory.reserve']))
  WHERE "isSystem" AND "name" IN ('Owner', 'Admin');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['products.view', 'inventory.view']))
  WHERE "isSystem" AND "name" = 'Member';

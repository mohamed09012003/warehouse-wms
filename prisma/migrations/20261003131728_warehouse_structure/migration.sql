-- CreateEnum
CREATE TYPE "WarehouseObjectType" AS ENUM ('WALL', 'DOOR', 'AISLE', 'LOADING_AREA', 'PACKING_AREA', 'WORK_AREA');

-- CreateTable
CREATE TABLE "PalletType" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "lengthMm" INTEGER NOT NULL,
    "heightMm" INTEGER,
    "maxLoadG" INTEGER,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PalletType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "lengthMm" INTEGER NOT NULL,
    "layoutVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarehouseObject" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "type" "WarehouseObjectType" NOT NULL,
    "label" TEXT,
    "xMm" INTEGER NOT NULL,
    "yMm" INTEGER NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "depthMm" INTEGER NOT NULL,
    "rotationDeg" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WarehouseObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rack" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT,
    "xMm" INTEGER NOT NULL,
    "yMm" INTEGER NOT NULL,
    "rotationDeg" INTEGER NOT NULL DEFAULT 0,
    "lengthMm" INTEGER NOT NULL,
    "depthMm" INTEGER NOT NULL,
    "heightMm" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Rack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RackLevel" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "rackId" UUID NOT NULL,
    "levelIndex" INTEGER NOT NULL,
    "elevationMm" INTEGER NOT NULL,
    "clearanceMm" INTEGER NOT NULL,
    "maxLoadG" INTEGER,

    CONSTRAINT "RackLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bay" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "rackId" UUID NOT NULL,
    "bayIndex" INTEGER NOT NULL,
    "offsetMm" INTEGER NOT NULL,
    "widthMm" INTEGER NOT NULL,
    "positionCount" INTEGER NOT NULL DEFAULT 1,
    "palletTypeId" UUID,

    CONSTRAINT "Bay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "warehouseId" UUID NOT NULL,
    "rackId" UUID NOT NULL,
    "levelId" UUID NOT NULL,
    "bayId" UUID NOT NULL,
    "positionIndex" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "palletTypeId" UUID,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PalletType_organizationId_id_key" ON "PalletType"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PalletType_organizationId_name_key" ON "PalletType"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_organizationId_id_key" ON "Warehouse"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_organizationId_code_key" ON "Warehouse"("organizationId", "code");

-- CreateIndex
CREATE INDEX "WarehouseObject_warehouseId_idx" ON "WarehouseObject"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_organizationId_id_key" ON "Rack"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_organizationId_warehouseId_id_key" ON "Rack"("organizationId", "warehouseId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Rack_warehouseId_code_key" ON "Rack"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RackLevel_rackId_levelIndex_key" ON "RackLevel"("rackId", "levelIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RackLevel_organizationId_rackId_id_key" ON "RackLevel"("organizationId", "rackId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Bay_rackId_bayIndex_key" ON "Bay"("rackId", "bayIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Bay_organizationId_rackId_id_key" ON "Bay"("organizationId", "rackId", "id");

-- CreateIndex
CREATE INDEX "Position_rackId_idx" ON "Position"("rackId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_warehouseId_code_key" ON "Position"("warehouseId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Position_bayId_levelId_positionIndex_key" ON "Position"("bayId", "levelId", "positionIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Position_organizationId_id_key" ON "Position"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "PalletType" ADD CONSTRAINT "PalletType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarehouseObject" ADD CONSTRAINT "WarehouseObject_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_organizationId_warehouseId_fkey" FOREIGN KEY ("organizationId", "warehouseId") REFERENCES "Warehouse"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RackLevel" ADD CONSTRAINT "RackLevel_organizationId_rackId_fkey" FOREIGN KEY ("organizationId", "rackId") REFERENCES "Rack"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bay" ADD CONSTRAINT "Bay_organizationId_rackId_fkey" FOREIGN KEY ("organizationId", "rackId") REFERENCES "Rack"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bay" ADD CONSTRAINT "Bay_organizationId_palletTypeId_fkey" FOREIGN KEY ("organizationId", "palletTypeId") REFERENCES "PalletType"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_warehouseId_rackId_fkey" FOREIGN KEY ("organizationId", "warehouseId", "rackId") REFERENCES "Rack"("organizationId", "warehouseId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_rackId_levelId_fkey" FOREIGN KEY ("organizationId", "rackId", "levelId") REFERENCES "RackLevel"("organizationId", "rackId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_rackId_bayId_fkey" FOREIGN KEY ("organizationId", "rackId", "bayId") REFERENCES "Bay"("organizationId", "rackId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_palletTypeId_fkey" FOREIGN KEY ("organizationId", "palletTypeId") REFERENCES "PalletType"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (Prisma cannot express CHECKs). See docs/database.md.
-- ---------------------------------------------------------------------------
ALTER TABLE "PalletType" ADD CONSTRAINT "PalletType_dims_check"
  CHECK ("widthMm" > 0 AND "lengthMm" > 0 AND ("heightMm" IS NULL OR "heightMm" > 0) AND ("maxLoadG" IS NULL OR "maxLoadG" > 0));

ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_dims_check" CHECK ("widthMm" > 0 AND "lengthMm" > 0);
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_code_format_check" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$');

ALTER TABLE "WarehouseObject" ADD CONSTRAINT "WarehouseObject_dims_check"
  CHECK ("widthMm" > 0 AND "depthMm" > 0 AND "rotationDeg" >= 0 AND "rotationDeg" < 360);

ALTER TABLE "Rack" ADD CONSTRAINT "Rack_dims_check"
  CHECK ("lengthMm" > 0 AND "depthMm" > 0 AND "heightMm" > 0 AND "rotationDeg" >= 0 AND "rotationDeg" < 360);
-- Rack codes are location-code segments: no hyphen (it is the separator), so codes can be parsed.
ALTER TABLE "Rack" ADD CONSTRAINT "Rack_code_format_check" CHECK ("code" ~ '^[A-Z0-9]{1,12}$');

ALTER TABLE "RackLevel" ADD CONSTRAINT "RackLevel_dims_check"
  CHECK ("levelIndex" >= 0 AND "elevationMm" >= 0 AND "clearanceMm" > 0 AND ("maxLoadG" IS NULL OR "maxLoadG" > 0));

ALTER TABLE "Bay" ADD CONSTRAINT "Bay_dims_check"
  CHECK ("bayIndex" >= 1 AND "offsetMm" >= 0 AND "widthMm" > 0 AND "positionCount" >= 1);

ALTER TABLE "Position" ADD CONSTRAINT "Position_index_check" CHECK ("positionIndex" >= 1);

-- ---------------------------------------------------------------------------
-- Data migration: new permissions for the built-in roles that already exist.
-- (Permission names live in code; role assignment is data.)
-- ---------------------------------------------------------------------------
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['warehouse.view', 'warehouse.design']))
  WHERE "isSystem" AND "name" IN ('Owner', 'Admin');
UPDATE "Role" SET "permissions" = ARRAY(SELECT DISTINCT unnest("permissions" || ARRAY['warehouse.view']))
  WHERE "isSystem" AND "name" = 'Member';

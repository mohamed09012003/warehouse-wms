import { NotFoundError, ConflictError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { warehouseRepo } from "../repo/warehouseRepo";
import { createPalletTypeSchema, createWarehouseSchema } from "../schemas";
import type { LayoutDto, PalletTypeDto, RackElevationDto, WarehouseDto } from "../types";

function toWarehouseDto(w: { id: string; code: string; name: string; widthMm: number; lengthMm: number; layoutVersion: number }): WarehouseDto {
  return { id: w.id, code: w.code, name: w.name, widthMm: w.widthMm, lengthMm: w.lengthMm, layoutVersion: w.layoutVersion };
}

export async function listWarehouses(ctx: TenantContext) {
  requirePermission(ctx, "warehouse.view");
  const rows = await warehouseRepo(ctx).list();
  return rows.map((w) => ({ ...toWarehouseDto(w), rackCount: w._count.racks, objectCount: w._count.objects }));
}

export async function createWarehouse(ctx: TenantContext, raw: unknown): Promise<WarehouseDto> {
  requirePermission(ctx, "warehouse.design");
  const input = parseInput(createWarehouseSchema, raw);
  try {
    return toWarehouseDto(await warehouseRepo(ctx).create(input));
  } catch (error) {
    if ((error as { code?: unknown })?.code === "P2002") throw new ConflictError(`Warehouse code "${input.code}" is already in use`);
    throw error;
  }
}

/** The full floor plan, generated from database rows. */
export async function getLayout(ctx: TenantContext, warehouseId: string): Promise<LayoutDto> {
  requirePermission(ctx, "warehouse.view");
  const repo = warehouseRepo(ctx);
  const warehouse = await repo.findById(warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse not found");
  const [objects, racks] = await Promise.all([repo.objects(warehouseId), repo.racks(warehouseId)]);
  return {
    warehouse: toWarehouseDto(warehouse),
    objects: objects.map((o) => ({
      id: o.id,
      type: o.type,
      label: o.label,
      xMm: o.xMm,
      yMm: o.yMm,
      widthMm: o.widthMm,
      depthMm: o.depthMm,
      rotationDeg: o.rotationDeg,
    })),
    racks: racks.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      xMm: r.xMm,
      yMm: r.yMm,
      rotationDeg: r.rotationDeg,
      lengthMm: r.lengthMm,
      depthMm: r.depthMm,
      heightMm: r.heightMm,
      levels: r.levels.map((l) => ({ elevationMm: l.elevationMm, clearanceMm: l.clearanceMm, maxLoadG: l.maxLoadG })),
      bays: r.bays.map((b) => ({ widthMm: b.widthMm, positionCount: b.positionCount, palletTypeId: b.palletTypeId })),
    })),
  };
}

/** Levels, bays and positions of one rack, straight from the database (for the elevation view). */
export async function getRackElevation(ctx: TenantContext, warehouseId: string, rackId: string): Promise<RackElevationDto> {
  requirePermission(ctx, "warehouse.view");
  const repo = warehouseRepo(ctx);
  const rack = await repo.findRack(warehouseId, rackId);
  if (!rack) throw new NotFoundError("Rack not found");
  const [levels, bays, positions] = await Promise.all([repo.levels(rackId), repo.bays(rackId), repo.positionsDetailed(rackId)]);
  return {
    rack: { id: rack.id, code: rack.code, name: rack.name, lengthMm: rack.lengthMm, depthMm: rack.depthMm, heightMm: rack.heightMm },
    levels: levels.map((l) => ({ id: l.id, levelIndex: l.levelIndex, elevationMm: l.elevationMm, clearanceMm: l.clearanceMm })),
    bays: bays.map((b) => ({
      id: b.id,
      bayIndex: b.bayIndex,
      offsetMm: b.offsetMm,
      widthMm: b.widthMm,
      positionCount: b.positionCount,
      palletType: b.palletType
        ? { id: b.palletType.id, name: b.palletType.name, widthMm: b.palletType.widthMm, lengthMm: b.palletType.lengthMm }
        : null,
    })),
    positions: positions
      .map((p) => ({
        id: p.id,
        levelIndex: p.level.levelIndex,
        bayIndex: p.bay.bayIndex,
        positionIndex: p.positionIndex,
        // Stored code; the UI regenerates the display code from the structured fields.
        code: p.code,
      }))
      .sort((a, b) => a.levelIndex - b.levelIndex || a.bayIndex - b.bayIndex || a.positionIndex - b.positionIndex),
  };
}

export async function listPalletTypes(ctx: TenantContext): Promise<PalletTypeDto[]> {
  requirePermission(ctx, "warehouse.view");
  const rows = await warehouseRepo(ctx).palletTypes();
  return rows.map((p) => ({ id: p.id, name: p.name, widthMm: p.widthMm, lengthMm: p.lengthMm, heightMm: p.heightMm, maxLoadG: p.maxLoadG }));
}

export async function createPalletType(ctx: TenantContext, raw: unknown): Promise<PalletTypeDto> {
  requirePermission(ctx, "warehouse.design");
  const input = parseInput(createPalletTypeSchema, raw);
  try {
    const p = await warehouseRepo(ctx).createPalletType(input);
    return { id: p.id, name: p.name, widthMm: p.widthMm, lengthMm: p.lengthMm, heightMm: p.heightMm, maxLoadG: p.maxLoadG };
  } catch (error) {
    if ((error as { code?: unknown })?.code === "P2002") throw new ConflictError(`Pallet type "${input.name}" already exists`);
    throw error;
  }
}

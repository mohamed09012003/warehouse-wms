import { NotFoundError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { inventoryRepo } from "../repo/inventoryRepo";
import { listMovementsSchema, listStockSchema } from "../schemas";
import type { MovementDto, ReservationDto, StockRowDto } from "../types";

export async function listStock(ctx: TenantContext, raw: unknown = {}): Promise<StockRowDto[]> {
  requirePermission(ctx, "inventory.view");
  const rows = await inventoryRepo(ctx).listStock(parseInput(listStockSchema, raw));
  return rows.map((b) => ({
    balanceId: b.id,
    productId: b.productId,
    sku: b.product.sku,
    productName: b.product.name,
    warehouseId: b.warehouseId,
    warehouseCode: b.position.rack.warehouse.code,
    positionId: b.positionId,
    positionCode: b.position.code,
    onHand: b.onHand,
    reserved: b.reserved,
    available: b.onHand - b.reserved,
  }));
}

export async function listMovements(ctx: TenantContext, raw: unknown = {}): Promise<MovementDto[]> {
  requirePermission(ctx, "inventory.view");
  const input = parseInput(listMovementsSchema, raw);
  const rows = await inventoryRepo(ctx).listMovements({ ...input, limit: input.limit ?? 50 });
  return rows.map((m) => ({
    id: m.id,
    operationId: m.operationId,
    type: m.type,
    productId: m.productId,
    sku: m.product.sku,
    positionId: m.positionId,
    positionCode: m.positionCode,
    counterpartPositionCode: m.counterpartPositionCode,
    qtyDelta: m.qtyDelta,
    reservedDelta: m.reservedDelta,
    onHandAfter: m.onHandAfter,
    reservedAfter: m.reservedAfter,
    createdAt: m.createdAt.toISOString(),
    reason: m.operation.reason,
    actorName: m.operation.actor?.name ?? null,
  }));
}

function toReservationDto(r: NonNullable<Awaited<ReturnType<ReturnType<typeof inventoryRepo>["findReservation"]>>>): ReservationDto {
  return {
    id: r.id,
    status: r.status,
    refType: r.refType,
    refId: r.refId,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    releasedAt: r.releasedAt?.toISOString() ?? null,
    lines: r.lines.map((l) => ({ productId: l.productId, sku: l.product.sku, positionId: l.positionId, positionCode: l.positionCode, quantity: l.quantity, consumedQuantity: l.consumedQuantity })),
  };
}

export async function listReservations(ctx: TenantContext, status?: "ACTIVE" | "RELEASED"): Promise<ReservationDto[]> {
  requirePermission(ctx, "inventory.view");
  return (await inventoryRepo(ctx).listReservations(status)).map(toReservationDto);
}

export async function getReservation(ctx: TenantContext, id: string): Promise<ReservationDto> {
  requirePermission(ctx, "inventory.view");
  const r = await inventoryRepo(ctx).findReservation(id);
  if (!r) throw new NotFoundError("Reservation not found");
  return toReservationDto(r);
}

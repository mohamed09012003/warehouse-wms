// Stock-changing operations. All business rules for quantity changes live here; callers (API
// routes, UI) only validate input shape and call these functions.
//
// Every operation: (1) checks permission, (2) validates input with Zod, (3) verifies tenant
// ownership of products and positions, (4) runs ONE database transaction that changes balances
// through the guarded statements in the repo and writes the operation header + movement rows.
import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PositionOccupiedError,
  ValidationError,
  normalizeError,
  parseInput,
} from "@/lib/errors";
import { lookupProducts } from "@/modules/catalog";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { lookupPositions } from "@/modules/warehouse";
import { withTransaction, type Tx } from "@/server/db";
import { inventoryRepo, type InventoryRepo, type MovementRow } from "../repo/inventoryRepo";
import {
  adjustStockSchema,
  createReservationSchema,
  moveStockSchema,
  receiveStockSchema,
  releaseReservationSchema,
} from "../schemas";
import type { InventoryMovementTypeName as InventoryMovementType, MovementDto, OperationResultDto } from "../types";

type Movement = Awaited<ReturnType<InventoryRepo["movementsOfOperation"]>>[number];

function toMovementDto(m: Movement): MovementDto {
  return {
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
  };
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

function hashRequest(type: string, request: unknown): string {
  return createHash("sha256").update(JSON.stringify([type, request])).digest("hex");
}

interface OperationSpec {
  type: InventoryMovementType;
  idempotencyKey?: string;
  /** The validated request without the idempotency key; used to detect key reuse with different data. */
  request: unknown;
  reason?: string;
  refType?: string;
  refId?: string;
}

/**
 * Run one inventory operation transactionally with idempotency support.
 * `apply` receives a transaction-bound repo and must perform all balance changes through it and
 * return the movement rows to record. A replay (same key, same request) returns the original
 * result without applying anything again.
 */
async function runOperation(
  ctx: TenantContext,
  spec: OperationSpec,
  apply: (repo: InventoryRepo, tx: Tx) => Promise<MovementRow[]>,
  extra: { reservationId?: string } = {},
): Promise<OperationResultDto> {
  const requestHash = hashRequest(spec.type, spec.request);

  const replay = async (): Promise<OperationResultDto | null> => {
    if (!spec.idempotencyKey) return null;
    const existing = await inventoryRepo(ctx).findOperationByKey(spec.idempotencyKey);
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new ConflictError("This idempotency key was already used for a different request");
    }
    const movements = await inventoryRepo(ctx).movementsOfOperation(existing.id);
    return {
      operationId: existing.id,
      replayed: true,
      movements: movements.map(toMovementDto),
      reservationId: existing.refType === "RESERVATION" ? (existing.refId ?? undefined) : undefined,
    };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return await withTransaction(async (tx) => {
      const repo = inventoryRepo(ctx, tx);
      const operation = await repo.createOperation({
        type: spec.type,
        idempotencyKey: spec.idempotencyKey,
        requestHash,
        reason: spec.reason,
        refType: spec.refType,
        refId: spec.refId,
      });
      const rows = await apply(repo, tx);
      await repo.insertMovements(operation.id, rows);
      const movements = await repo.movementsOfOperation(operation.id);
      return { operationId: operation.id, replayed: false, movements: movements.map(toMovementDto), ...extra };
    });
  } catch (error) {
    // Two requests with the same key raced: the loser's insert hit the unique index. Return the winner's result.
    if (spec.idempotencyKey && isUniqueViolation(error)) {
      const raced = await replay();
      if (raced) return raced;
    }
    // Translate known database failures (CHECK / FK violations) into typed errors; leave the rest untouched.
    const known = normalizeError(error);
    if (known.code !== "INTERNAL_ERROR") throw known;
    throw error;
  }
}

// ---- validation helpers ---------------------------------------------------------------------

async function requireProducts(ctx: TenantContext, ids: string[], opts: { mustBeActive: boolean }) {
  const found = await lookupProducts(ctx, ids);
  for (const id of ids) {
    const p = found.get(id);
    if (!p) throw new NotFoundError("Product not found");
    if (opts.mustBeActive && !p.active) throw new ValidationError(`Product ${p.sku} is disabled`);
  }
  return found;
}

async function requirePositions(ctx: TenantContext, ids: string[]) {
  const found = await lookupPositions(ctx, ids);
  for (const id of ids) if (!found.has(id)) throw new NotFoundError("Position not found");
  return found;
}

async function availableMessage(repo: InventoryRepo, positionId: string, productId: string, code: string, wanted: number) {
  const b = await repo.getBalance(positionId, productId);
  const available = b ? b.onHand - b.reserved : 0;
  return { message: `Not enough available stock at ${code}: ${available} available, ${wanted} requested`, details: { available, requested: wanted } };
}

/**
 * A position holds ONE product at a time (stock of the same product may grow freely). This check
 * gives a precise message; it is NOT the safety net. The partial unique index
 * InventoryBalance_one_product_per_position_idx decides races between concurrent requests.
 * A position whose stock reached zero is empty and open to any product.
 */
async function assertPositionOpenFor(repo: InventoryRepo, position: { id: string; code: string }, productId: string) {
  const occupant = await repo.findOccupant(position.id);
  if (occupant && occupant.productId !== productId) {
    throw new PositionOccupiedError(
      `Position ${position.code} is already occupied by ${occupant.product.sku}. A position holds one product at a time: use another position.`,
      { positionCode: position.code, occupiedBySku: occupant.product.sku },
    );
  }
}

// ---- operations -----------------------------------------------------------------------------

export async function receiveStock(ctx: TenantContext, raw: unknown): Promise<OperationResultDto> {
  requirePermission(ctx, "inventory.adjust");
  const { idempotencyKey, ...input } = parseInput(receiveStockSchema, raw);
  await requireProducts(ctx, [input.productId], { mustBeActive: true });
  const position = (await requirePositions(ctx, [input.positionId])).get(input.positionId)!;

  return runOperation(ctx, { type: "RECEIVE", idempotencyKey, request: input, reason: input.reason }, async (repo) => {
    await assertPositionOpenFor(repo, position, input.productId);
    const after = await repo.receiveInto({ warehouseId: position.warehouseId, positionId: position.id, productId: input.productId, qty: input.quantity });
    return [
      {
        type: "RECEIVE",
        warehouseId: position.warehouseId,
        productId: input.productId,
        positionId: position.id,
        positionCode: position.code,
        qtyDelta: input.quantity,
        reservedDelta: 0,
        onHandAfter: after.onHand,
        reservedAfter: after.reserved,
      },
    ];
  });
}

export async function moveStock(ctx: TenantContext, raw: unknown): Promise<OperationResultDto> {
  requirePermission(ctx, "inventory.adjust");
  const { idempotencyKey, ...input } = parseInput(moveStockSchema, raw);
  await requireProducts(ctx, [input.productId], { mustBeActive: false });
  const positions = await requirePositions(ctx, [input.fromPositionId, input.toPositionId]);
  const from = positions.get(input.fromPositionId)!;
  const to = positions.get(input.toPositionId)!;
  if (from.warehouseId !== to.warehouseId) throw new ValidationError("Stock can only be moved within one warehouse");

  return runOperation(ctx, { type: "MOVE", idempotencyKey, request: input, reason: input.reason }, async (repo) => {
    await assertPositionOpenFor(repo, to, input.productId);
    // Deterministic lock order: always touch the lower position id first, so two opposite
    // transfers can never deadlock on each other's rows.
    const steps = [
      { side: "out" as const, position: from },
      { side: "in" as const, position: to },
    ].sort((a, b) => (a.position.id < b.position.id ? -1 : 1));

    const rows: MovementRow[] = [];
    for (const step of steps) {
      const counterpart = step.side === "out" ? to : from;
      if (step.side === "out") {
        const after = await repo.takeOut({ positionId: from.id, productId: input.productId, qty: input.quantity });
        if (!after) {
          const m = await availableMessage(repo, from.id, input.productId, from.code, input.quantity);
          throw new InsufficientStockError(m.message, m.details);
        }
        rows.push({
          type: "MOVE", warehouseId: from.warehouseId, productId: input.productId,
          positionId: from.id, positionCode: from.code, counterpartPositionId: counterpart.id, counterpartPositionCode: counterpart.code,
          qtyDelta: -input.quantity, reservedDelta: 0, onHandAfter: after.onHand, reservedAfter: after.reserved,
        });
      } else {
        const after = await repo.receiveInto({ warehouseId: to.warehouseId, positionId: to.id, productId: input.productId, qty: input.quantity });
        rows.push({
          type: "MOVE", warehouseId: to.warehouseId, productId: input.productId,
          positionId: to.id, positionCode: to.code, counterpartPositionId: counterpart.id, counterpartPositionCode: counterpart.code,
          qtyDelta: input.quantity, reservedDelta: 0, onHandAfter: after.onHand, reservedAfter: after.reserved,
        });
      }
    }
    // Record the source row first for readability.
    return rows.sort((a, b) => a.qtyDelta - b.qtyDelta);
  });
}

export async function adjustStock(ctx: TenantContext, raw: unknown): Promise<OperationResultDto> {
  requirePermission(ctx, "inventory.adjust");
  const { idempotencyKey, ...input } = parseInput(adjustStockSchema, raw);
  await requireProducts(ctx, [input.productId], { mustBeActive: input.delta > 0 });
  const position = (await requirePositions(ctx, [input.positionId])).get(input.positionId)!;
  const type: InventoryMovementType = input.delta > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";

  return runOperation(ctx, { type, idempotencyKey, request: input, reason: input.reason }, async (repo) => {
    const qty = Math.abs(input.delta);
    if (input.delta > 0) await assertPositionOpenFor(repo, position, input.productId);
    // A decrease may only consume AVAILABLE stock: it can never cut into reserved stock.
    const after =
      input.delta > 0
        ? await repo.receiveInto({ warehouseId: position.warehouseId, positionId: position.id, productId: input.productId, qty })
        : await repo.takeOut({ positionId: position.id, productId: input.productId, qty });
    if (!after) {
      const m = await availableMessage(repo, position.id, input.productId, position.code, qty);
      throw new InsufficientStockError(m.message, m.details);
    }
    return [
      {
        type,
        warehouseId: position.warehouseId,
        productId: input.productId,
        positionId: position.id,
        positionCode: position.code,
        qtyDelta: input.delta,
        reservedDelta: 0,
        onHandAfter: after.onHand,
        reservedAfter: after.reserved,
      },
    ];
  });
}

export async function createReservation(ctx: TenantContext, raw: unknown): Promise<OperationResultDto> {
  requirePermission(ctx, "inventory.reserve");
  const { idempotencyKey, ...input } = parseInput(createReservationSchema, raw);
  await requireProducts(ctx, input.lines.map((l) => l.productId), { mustBeActive: true });
  const positions = await requirePositions(ctx, input.lines.map((l) => l.positionId));

  // Deterministic lock order across all rows this operation touches.
  const lines = [...input.lines].sort((a, b) => (a.positionId + a.productId < b.positionId + b.productId ? -1 : 1));
  const reservationId = randomUUID();

  return runOperation(
    ctx,
    { type: "RESERVE", idempotencyKey, request: input, reason: input.note, refType: "RESERVATION", refId: reservationId },
    async (repo) => {
      const rows: MovementRow[] = [];
      for (const line of lines) {
        const position = positions.get(line.positionId)!;
        const after = await repo.reserve({ positionId: position.id, productId: line.productId, qty: line.quantity });
        if (!after) {
          const m = await availableMessage(repo, position.id, line.productId, position.code, line.quantity);
          throw new InsufficientStockError(m.message, m.details);
        }
        rows.push({
          type: "RESERVE", warehouseId: position.warehouseId, productId: line.productId,
          positionId: position.id, positionCode: position.code,
          qtyDelta: 0, reservedDelta: line.quantity, onHandAfter: after.onHand, reservedAfter: after.reserved,
        });
      }
      await repo.createReservation({
        id: reservationId,
        refType: input.refType,
        refId: input.refId,
        note: input.note,
        lines: lines.map((l) => ({ productId: l.productId, positionId: l.positionId, positionCode: positions.get(l.positionId)!.code, quantity: l.quantity })),
      });
      return rows;
    },
    { reservationId },
  );
}

export async function releaseReservation(ctx: TenantContext, raw: unknown): Promise<OperationResultDto> {
  requirePermission(ctx, "inventory.reserve");
  const { idempotencyKey, reservationId } = parseInput(releaseReservationSchema, raw);
  if (!(await inventoryRepo(ctx).findReservation(reservationId))) throw new NotFoundError("Reservation not found");

  return runOperation(
    ctx,
    { type: "RELEASE", idempotencyKey, request: { reservationId }, refType: "RESERVATION", refId: reservationId },
    async (repo) => {
      // ACTIVE -> RELEASED in one guarded statement: a second release finds nothing to update.
      if ((await repo.releaseIfActive(reservationId)) === 0) throw new ConflictError("Reservation is already released");
      const reservation = (await repo.findReservation(reservationId))!;
      const lines = [...reservation.lines].sort((a, b) => (a.positionId + a.productId < b.positionId + b.productId ? -1 : 1));
      const rows: MovementRow[] = [];
      for (const line of lines) {
        const after = await repo.unreserve({ positionId: line.positionId, productId: line.productId, qty: line.quantity });
        // Cannot happen while invariants hold (an active reservation is always backed by `reserved`).
        if (!after) throw new ConflictError(`Reserved quantity at ${line.positionCode} is inconsistent; release aborted`);
        const position = await repo.getBalance(line.positionId, line.productId);
        rows.push({
          type: "RELEASE", warehouseId: position!.warehouseId, productId: line.productId,
          positionId: line.positionId, positionCode: line.positionCode,
          qtyDelta: 0, reservedDelta: -line.quantity, onHandAfter: after.onHand, reservedAfter: after.reserved,
        });
      }
      return rows;
    },
    { reservationId },
  );
}

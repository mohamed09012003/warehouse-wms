// Stock operations that other modules (picking) compose into THEIR OWN transaction.
//
// The rule from CLAUDE.md still holds: only the inventory module changes balances. Picking does
// not touch InventoryBalance; it calls `stock.reservePlan / consume / releaseReservations` inside
// `runStockOperation`, which runs the caller's work and the stock changes in ONE database
// transaction together with the InventoryOperation header and the append-only movement rows.
//
// This is internal: it performs NO permission check (callers check their own permission) and has
// no HTTP route. Idempotency works exactly as for the public operations.
import { ReservationUnavailableError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy";
import type { Tx } from "@/server/db";
import { randomUUID } from "node:crypto";
import type { InventoryRepo, MovementRow } from "../repo/inventoryRepo";
import type { OperationResultDto } from "../types";
import { releaseOutstanding, runOperation, type OperationSpec } from "./operations";

export interface AvailablePosition {
  positionId: string;
  positionCode: string;
  warehouseId: string;
  available: number;
}

export interface ReservedPosition {
  reservationId: string;
  reservationLineId: string;
  positionId: string;
  positionCode: string;
  quantity: number;
}

export interface StockTx {
  /** Positions with available stock of a product, in stable physical order (rack, level, bay, position). */
  availableStock(productId: string): Promise<AvailablePosition[]>;
  /**
   * Reserve stock for work (allocation): for each planned position, reserve up to the planned
   * quantity (never more than is available at that moment) and create ONE reservation per
   * position that got stock. Positions are processed in ascending id order (deadlock-free lock
   * order). Returns what was actually reserved; positions that yielded nothing are omitted.
   */
  reservePlan(args: {
    productId: string;
    plan: { positionId: string; positionCode: string; warehouseId: string; quantity: number }[];
    refType: string;
    refId: string;
    note?: string;
  }): Promise<ReservedPosition[]>;
  /**
   * Consume reserved stock (picking): onHand and reserved both decrease, the reservation line's
   * consumed quantity increases, and the reservation closes (CONSUMED) when fully consumed.
   * Throws ReservationUnavailableError if the reservation is not ACTIVE or the stock is not there.
   */
  consume(args: { reservationLineId: string; quantity: number }): Promise<{ onHandAfter: number; reservedAfter: number; reservationClosed: boolean }>;
  /** Release the outstanding quantity of ACTIVE reservations (allocation release / cancel). */
  releaseReservations(reservationIds: string[]): Promise<number>;
}

function makeStockTx(repo: InventoryRepo, rows: MovementRow[]): StockTx {
  return {
    availableStock: (productId) => repo.availableStock(productId),

    async reservePlan({ productId, plan, refType, refId, note }) {
      const ordered = [...plan].sort((a, b) => (a.positionId < b.positionId ? -1 : 1));
      const out: ReservedPosition[] = [];
      for (const target of ordered) {
        if (target.quantity <= 0) continue;
        const res = await repo.reserveUpTo({ positionId: target.positionId, productId, qty: target.quantity });
        if (!res) continue; // someone else took the stock since planning: allocate what is left
        const reservationId = randomUUID();
        const reservation = await repo.createReservation({
          id: reservationId,
          refType,
          refId,
          note,
          lines: [{ productId, positionId: target.positionId, positionCode: target.positionCode, quantity: res.took }],
        });
        rows.push({
          type: "RESERVE",
          warehouseId: target.warehouseId,
          productId,
          positionId: target.positionId,
          positionCode: target.positionCode,
          qtyDelta: 0,
          reservedDelta: res.took,
          onHandAfter: res.onHand,
          reservedAfter: res.reserved,
        });
        out.push({
          reservationId,
          reservationLineId: reservation.lines[0].id,
          positionId: target.positionId,
          positionCode: target.positionCode,
          quantity: res.took,
        });
      }
      // report in the planner's (physical) order
      return plan.flatMap((p) => out.filter((o) => o.positionId === p.positionId));
    },

    async consume({ reservationLineId, quantity }) {
      const line = await repo.findReservationLine(reservationLineId);
      if (!line) throw new ReservationUnavailableError("Reservation line not found");
      // Lock order: reservation, then reservation line / balance.
      const reservation = await repo.lockReservation(line.reservationId);
      if (!reservation || reservation.status !== "ACTIVE") {
        throw new ReservationUnavailableError(`The reservation is ${reservation?.status.toLowerCase() ?? "missing"}; the stock is no longer reserved for this pick`);
      }
      const consumed = await repo.consumeLine(reservationLineId, quantity);
      if (!consumed) throw new ReservationUnavailableError("The reserved quantity left is smaller than the quantity being picked");
      const after = await repo.consume({ positionId: consumed.positionId, productId: consumed.productId, qty: quantity });
      if (!after) throw new ReservationUnavailableError(`The reserved stock at ${consumed.positionCode} is no longer there`);
      const balance = await repo.getBalance(consumed.positionId, consumed.productId);
      rows.push({
        type: "PICK",
        warehouseId: balance!.warehouseId,
        productId: consumed.productId,
        positionId: consumed.positionId,
        positionCode: consumed.positionCode,
        qtyDelta: -quantity,
        reservedDelta: -quantity,
        onHandAfter: after.onHand,
        reservedAfter: after.reserved,
      });
      const reservationClosed = await repo.closeReservationIfConsumed(line.reservationId);
      return { onHandAfter: after.onHand, reservedAfter: after.reserved, reservationClosed };
    },

    releaseReservations: (ids) => releaseOutstanding(repo, ids, rows),
  };
}

/**
 * Run `work` and its stock changes atomically. `work` runs inside the same transaction (`tx`) as the
 * stock changes, so domain updates (tasks, order lines, ...) commit or roll back together with them.
 * On an idempotent replay `work` is NOT run again; `value` is then undefined and the stored result is returned.
 */
export async function runStockOperation<T>(
  ctx: TenantContext,
  spec: OperationSpec,
  work: (stock: StockTx, tx: Tx) => Promise<T>,
): Promise<OperationResultDto & { value?: T }> {
  let value: T | undefined;
  const result = await runOperation(ctx, spec, async (repo, tx) => {
    const rows: MovementRow[] = [];
    value = await work(makeStockTx(repo, rows), tx);
    return rows;
  });
  return { ...result, value: result.replayed ? undefined : value };
}

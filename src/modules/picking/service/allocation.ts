// Allocation: reserve stock for an order (through the inventory module) and create the pick tasks.
//
// Partial allocation: as much as is available is allocated, the rest stays unallocated and is
// shown as such (status PARTIALLY_ALLOCATED, allocationState PARTIAL). Tasks exist only for stock
// that was actually reserved. If NOTHING can be allocated the request fails with INSUFFICIENT_STOCK
// and changes nothing. Allocating again later tops up the remainder (new reservations and tasks).
import { ConflictError, InsufficientStockError, InvalidStateError, NotFoundError, parseInput } from "@/lib/errors";
import { runStockOperation } from "@/modules/inventory";
import { ALLOCATABLE_STATUSES, CANCELLABLE_STATUSES, RELEASABLE_STATUSES, allocationState, deriveFulfilmentStatus } from "@/modules/orders";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { withTransaction } from "@/server/db";
import { planAllocation } from "../domain/allocation";
import { pickingRepo } from "../repo/pickingRepo";
import { orderActionSchema } from "../schemas";
import type { AllocationResultDto, OrderActionResultDto } from "../types";
import { cancelOpenTasks, completeWavesWithoutOpenTasks, refreshOrderStatus } from "./taskCancellation";

async function currentOrderState(ctx: TenantContext, orderId: string) {
  const pk = pickingRepo(ctx);
  const [order, lines] = await Promise.all([pk.findOrder(orderId), pk.orderLines(orderId)]);
  if (!order) throw new NotFoundError("Order not found");
  return {
    status: order.status,
    allocationState: allocationState(lines),
    requestedTotal: lines.reduce((n, l) => n + l.requestedQty, 0),
    allocatedTotal: lines.reduce((n, l) => n + l.allocatedQty, 0),
  };
}

export async function allocateOrder(ctx: TenantContext, raw: unknown): Promise<AllocationResultDto> {
  requirePermission(ctx, "picking.manage");
  const { orderId, idempotencyKey } = parseInput(orderActionSchema, raw);
  const order = await pickingRepo(ctx).findOrder(orderId);
  if (!order) throw new NotFoundError("Order not found");

  const result = await runStockOperation(
    ctx,
    { type: "RESERVE", idempotencyKey, request: { action: "allocate", orderId }, refType: "ORDER", refId: orderId, reason: `Allocation for order ${order.orderNumber}` },
    async (stock, tx) => {
      const pk = pickingRepo(ctx, tx);
      // Lock order: Order -> (inventory: Balance) -> OrderLine updates.
      const [locked] = await pk.lockOrders([orderId]);
      if (!locked) throw new NotFoundError("Order not found");
      if (!ALLOCATABLE_STATUSES.includes(locked.status)) {
        throw new InvalidStateError(`An order can be allocated when it is READY, PARTIALLY_ALLOCATED or PICKING (this order is ${locked.status})`);
      }
      const lines = await pk.orderLines(orderId);
      const needing = lines.filter((l) => l.requestedQty - l.allocatedQty > 0);
      if (needing.length === 0) throw new InvalidStateError("This order is already fully allocated");

      let allocatedNow = 0;
      let tasksCreated = 0;
      for (const line of needing) {
        const remaining = line.requestedQty - line.allocatedQty;
        // Deterministic: positions with available stock in physical order, first positions first.
        const plan = planAllocation(remaining, await stock.availableStock(line.productId));
        if (plan.length === 0) continue;
        const reserved = await stock.reservePlan({
          productId: line.productId,
          plan,
          refType: "ORDER_LINE",
          refId: line.id,
          note: `Order ${locked.orderNumber}`,
        });
        const took = reserved.reduce((n, r) => n + r.quantity, 0);
        if (took === 0) continue;
        for (const r of reserved) {
          await pk.createTask({
            orderId,
            orderLineId: line.id,
            productId: line.productId,
            positionId: r.positionId,
            positionCode: r.positionCode,
            reservationId: r.reservationId,
            reservationLineId: r.reservationLineId,
            quantity: r.quantity,
          });
        }
        if (!(await pk.increaseAllocated(line.id, took))) throw new ConflictError("Order line quantities changed during allocation; please retry");
        allocatedNow += took;
        tasksCreated += reserved.length;
      }
      if (allocatedNow === 0) {
        throw new InsufficientStockError("No stock is available to allocate for this order. Nothing was reserved.", { orderId });
      }
      await pk.setOrderStatus(orderId, deriveFulfilmentStatus(await pk.orderLines(orderId)));
      return { allocatedNow, tasksCreated };
    },
  );

  return { orderId, replayed: result.replayed, allocatedNow: result.value?.allocatedNow ?? 0, tasksCreated: result.value?.tasksCreated ?? 0, ...(await currentOrderState(ctx, orderId)) };
}

/**
 * Stop the picking work of an order: cancel its open tasks, release their reservations through the
 * inventory module and give the quantity back on the lines. Used by "release allocation" (before any
 * picking, order returns to READY) and "cancel order" (order becomes CANCELLED; stock already picked
 * stays consumed and the history is kept).
 */
async function stopOrderWork(
  ctx: TenantContext,
  raw: unknown,
  mode: "release" | "cancel",
): Promise<OrderActionResultDto> {
  const { orderId, idempotencyKey } = parseInput(orderActionSchema, raw);
  const pk0 = pickingRepo(ctx);
  const order = await pk0.findOrder(orderId);
  if (!order) throw new NotFoundError("Order not found");
  const preTasks = await pk0.taskIdsOfOrder(orderId);
  const waveIds = preTasks.flatMap((t) => (t.waveId ? [t.waveId] : []));

  const work = async (stock: { releaseReservations: (ids: string[]) => Promise<number> }, tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    const pk = pickingRepo(ctx, tx);
    // Lock order: Wave -> Order -> Task -> Reservation -> Balance.
    const waves = await pk.lockWaves(waveIds);
    const [locked] = await pk.lockOrders([orderId]);
    if (!locked) throw new NotFoundError("Order not found");
    if (mode === "release" && !RELEASABLE_STATUSES.includes(locked.status)) {
      throw new InvalidStateError(`Only an allocated order that has not started picking can be released (this order is ${locked.status})`);
    }
    if (mode === "cancel" && !CANCELLABLE_STATUSES.includes(locked.status)) {
      throw new InvalidStateError(`An order that is ${locked.status} cannot be cancelled`);
    }
    // Packing is recorded work on picked goods: it must be cancelled (or completed) first.
    if (mode === "cancel" && (await pk.hasOpenPackingSession(orderId))) {
      throw new InvalidStateError("This order has an open packing session. Cancel or complete the packing session first.");
    }

    const now = await pk.taskIdsOfOrder(orderId);
    const lockedWaveIds = new Set(waves.map((w) => w.id));
    if (now.some((t) => t.waveId && !lockedWaveIds.has(t.waveId))) throw new ConflictError("The order was added to a wave while this action ran. Please retry.");
    const tasks = await pk.lockTasks(now.map((t) => t.id));

    if (mode === "release") {
      const waveStatus = new Map(waves.map((w) => [w.id, w]));
      for (const t of tasks) {
        const w = t.waveId ? waveStatus.get(t.waveId) : undefined;
        if (w && w.status !== "DRAFT") throw new InvalidStateError(`Some tasks are in wave W-${String(w.number).padStart(4, "0")} (${w.status}); cancel that wave first`);
        if (t.pickedQty > 0) throw new InvalidStateError("Picking has already started for this order; cancel the order instead");
      }
    }

    const { cancelled } = await cancelOpenTasks(pk, stock, tasks);
    if (mode === "cancel") await pk.setOrderStatus(orderId, "CANCELLED");
    else await refreshOrderStatus(pk, orderId);
    await completeWavesWithoutOpenTasks(pk, waves);
    return { cancelled };
  };

  // Nothing reserved -> no stock operation (and no empty ledger header).
  if (preTasks.length === 0) {
    const out = await withTransaction((tx) => work({ releaseReservations: async () => 0 }, tx));
    return { orderId, replayed: false, status: (await currentOrderState(ctx, orderId)).status, tasksCancelled: out.cancelled };
  }

  const result = await runStockOperation(
    ctx,
    {
      type: "RELEASE",
      idempotencyKey,
      request: { action: mode, orderId },
      refType: "ORDER",
      refId: orderId,
      reason: `${mode === "cancel" ? "Cancel" : "Release allocation of"} order ${order.orderNumber}`,
    },
    work,
  );
  return { orderId, replayed: result.replayed, status: (await currentOrderState(ctx, orderId)).status, tasksCancelled: result.value?.cancelled ?? 0 };
}

export async function releaseOrderAllocation(ctx: TenantContext, raw: unknown): Promise<OrderActionResultDto> {
  requirePermission(ctx, "picking.manage");
  return stopOrderWork(ctx, raw, "release");
}

export async function cancelOrder(ctx: TenantContext, raw: unknown): Promise<OrderActionResultDto> {
  requirePermission(ctx, "orders.manage");
  return stopOrderWork(ctx, raw, "cancel");
}

// Shared steps for flows that stop picking work (release allocation, cancel order, cancel wave).
// All of them must already hold the locks required by the lock order in pickingRepo.ts.
import { ConflictError } from "@/lib/errors";
import { deriveFulfilmentStatus } from "@/modules/orders";
import type { StockTx } from "@/modules/inventory";
import type { LockedTask, LockedWave, PickingRepo } from "../repo/pickingRepo";

const OPEN = ["PENDING", "IN_PROGRESS"];

/**
 * Cancel the open tasks, release their reservations (outstanding stock only; picked stock stays
 * consumed) and give the unpicked quantity back on the order lines (allocated -= outstanding).
 * Returns the number of tasks cancelled and the orders affected.
 */
export async function cancelOpenTasks(
  pk: PickingRepo,
  stock: Pick<StockTx, "releaseReservations">,
  tasks: LockedTask[],
): Promise<{ cancelled: number; orderIds: Set<string> }> {
  const open = tasks.filter((t) => OPEN.includes(t.status));
  const orderIds = new Set(open.map((t) => t.orderId));
  if (open.length === 0) return { cancelled: 0, orderIds };

  await pk.cancelTasks(open.map((t) => t.id));
  await stock.releaseReservations(open.map((t) => t.reservationId));

  const outstandingByLine = new Map<string, number>();
  for (const t of open) outstandingByLine.set(t.orderLineId, (outstandingByLine.get(t.orderLineId) ?? 0) + (t.quantity - t.pickedQty));
  for (const [lineId, qty] of [...outstandingByLine.entries()].sort()) {
    if (qty > 0 && !(await pk.decreaseAllocated(lineId, qty))) {
      throw new ConflictError("Order line quantities are inconsistent; the change was aborted");
    }
  }
  return { cancelled: open.length, orderIds };
}

/** Recompute an order's fulfilment status from its lines (not for DRAFT / CANCELLED / PICKED orders). */
export async function refreshOrderStatus(pk: PickingRepo, orderId: string): Promise<void> {
  const lines = await pk.orderLines(orderId);
  await pk.setOrderStatus(orderId, deriveFulfilmentStatus(lines));
}

/** A wave that is IN_PROGRESS and has no open task left is COMPLETED. */
export async function completeWavesWithoutOpenTasks(pk: PickingRepo, waves: LockedWave[]): Promise<void> {
  for (const wave of waves) {
    if (wave.status === "IN_PROGRESS" && (await pk.openTaskCountOfWave(wave.id)) === 0) {
      await pk.transitionWave(wave.id, ["IN_PROGRESS"], "COMPLETED", "completedAt");
    }
  }
}

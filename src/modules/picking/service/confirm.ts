// Pick confirmation: the ONE operation behind the picker screen and (later) a barcode scanner.
// A scanner only needs to send what it reads: a location code and a SKU/barcode.
//
// Everything happens in one database transaction, together with the inventory consumption:
//   lock wave -> lock order -> lock task -> validate -> consume reserved stock (inventory module:
//   onHand and reserved both decrease, PICK movement, reservation line consumed) -> task picked ->
//   order line picked -> order status -> wave status.
// Any failure rolls the whole thing back. Duplicate submissions are neutralized by the
// Idempotency-Key (same key = applied once) and by the guarded updates (a task cannot be
// over-picked or completed twice, even without a key).
import {
  InvalidStateError,
  NotFoundError,
  PickQuantityError,
  TaskNotPickableError,
  WrongLocationError,
  WrongProductError,
  parseInput,
} from "@/lib/errors";
import { resolveProductCode } from "@/modules/catalog";
import { runStockOperation } from "@/modules/inventory";
import { deriveFulfilmentStatus } from "@/modules/orders";
import { lineSummaries, orderPayload, recordEvent } from "@/modules/outbox";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { lookupPositions, resolvePositionCode } from "@/modules/warehouse";
import { pickingRepo } from "../repo/pickingRepo";
import { confirmPickSchema } from "../schemas";
import type { PickResultDto } from "../types";
import { getPickTask } from "./queries";

const ORDER_PICKABLE = ["ALLOCATED", "PARTIALLY_ALLOCATED", "PICKING"];

export async function confirmPick(ctx: TenantContext, raw: unknown): Promise<PickResultDto> {
  requirePermission(ctx, "picking.manage");
  const input = parseInput(confirmPickSchema, raw);
  const { idempotencyKey, ...request } = input;

  const task0 = await pickingRepo(ctx).findTask(input.taskId);
  if (!task0) throw new NotFoundError("Pick task not found");

  // 1. The picker must be at the assigned location (resolved to a real Position, compared by id).
  const position = (await lookupPositions(ctx, [task0.positionId])).get(task0.positionId);
  const scannedPosition = position ? await resolvePositionCode(ctx, position.warehouseId, input.locationCode) : null;
  if (!scannedPosition || scannedPosition.id !== task0.positionId) {
    throw new WrongLocationError(`Wrong location "${input.locationCode}". This pick is at ${task0.positionCode}.`, { expected: task0.positionCode });
  }
  // 2. ... and holding the assigned product (SKU or any barcode of the organization).
  const scannedProduct = await resolveProductCode(ctx, input.productCode);
  if (!scannedProduct || scannedProduct.id !== task0.productId) {
    throw new WrongProductError(`Wrong product "${input.productCode}" for this pick.`);
  }

  const order0 = await pickingRepo(ctx).findOrder(task0.orderId);

  const result = await runStockOperation(
    ctx,
    {
      type: "PICK",
      idempotencyKey,
      request,
      refType: "PICK_TASK",
      refId: task0.id,
      reason: `Pick for order ${order0?.orderNumber ?? ""}`.trim(),
    },
    async (stock, tx) => {
      const pk = pickingRepo(ctx, tx);

      // Lock order: Wave -> Order -> Task (then Reservation -> Balance inside stock.consume).
      const waves = task0.waveId ? await pk.lockWaves([task0.waveId]) : [];
      const [order] = await pk.lockOrders([task0.orderId]);
      const [task] = await pk.lockTasks([task0.id]);
      if (!order || !task) throw new NotFoundError("Pick task not found");

      if (task.status === "COMPLETED") throw new TaskNotPickableError("This task is already completed.");
      if (task.status === "CANCELLED") throw new TaskNotPickableError("This task was cancelled.");
      const wave = waves[0];
      if (!task.waveId || !wave) throw new TaskNotPickableError("This task is not in a wave yet.");
      if (wave.status !== "IN_PROGRESS") throw new TaskNotPickableError(`Wave W-${String(wave.number).padStart(4, "0")} is ${wave.status}; start picking before confirming picks.`);
      if (!ORDER_PICKABLE.includes(order.status)) throw new TaskNotPickableError(`Order ${order.orderNumber} is ${order.status}.`);

      const remainingOnTask = task.quantity - task.pickedQty;
      if (input.quantity > remainingOnTask) {
        throw new PickQuantityError(`Only ${remainingOnTask} left to pick on this task (you entered ${input.quantity}).`, { remaining: remainingOnTask });
      }
      const line = (await pk.orderLines(order.id)).find((l) => l.id === task.orderLineId);
      if (!line) throw new InvalidStateError("Order line not found");
      if (input.quantity > line.requestedQty - line.pickedQty) {
        throw new PickQuantityError(`Only ${line.requestedQty - line.pickedQty} still to be picked for this order line.`);
      }

      // Inventory consumption (guarded; throws RESERVATION_UNAVAILABLE if the reservation no longer holds the stock).
      const stockAfter = await stock.consume({ reservationLineId: task.reservationLineId, quantity: input.quantity });

      const updatedTask = await pk.increaseTaskPicked(task.id, input.quantity);
      if (!updatedTask) throw new TaskNotPickableError("This task changed while picking; reload and retry.");
      if (!(await pk.increasePicked(task.orderLineId, input.quantity))) {
        throw new PickQuantityError("This would pick more than was allocated for the order line.");
      }

      // A packing session opened while the order was only partly picked: once the last unit is picked
      // the order is being packed, not merely PICKED.
      const linesAfter = await pk.orderLines(order.id);
      let status: string = deriveFulfilmentStatus(linesAfter);
      if (status === "PICKED" && (await pk.hasOpenPackingSession(order.id))) status = "PACKING";
      await pk.setOrderStatus(order.id, status as Parameters<typeof pk.setOrderStatus>[1]);
      // The pick that completes the order (every requested unit picked) is exactly one business transition.
      if (status === "PICKED" || status === "PACKING") {
        await recordEvent(tx, ctx, {
          type: "order.picked",
          payload: orderPayload(order, { status, pickedTotal: linesAfter.reduce((n, l) => n + l.pickedQty, 0), lines: lineSummaries(linesAfter) }),
        });
      }

      // Wave: completed automatically when its last open task is done.
      let waveStatus = wave.status as string;
      if ((await pk.openTaskCountOfWave(wave.id)) === 0) {
        await pk.transitionWave(wave.id, ["IN_PROGRESS"], "COMPLETED", "completedAt");
        waveStatus = "COMPLETED";
      }
      return { stockAfter, orderStatus: status, waveStatus };
    },
  );

  const task = await getPickTask(ctx, task0.id);
  const order = await pickingRepo(ctx).findOrder(task0.orderId);
  return {
    operationId: result.operationId,
    replayed: result.replayed,
    task,
    orderStatus: (order?.status ?? task.orderStatus) as PickResultDto["orderStatus"],
    waveStatus: task.waveStatus,
    onHandAfter: result.value?.stockAfter.onHandAfter,
    reservedAfter: result.value?.stockAfter.reservedAfter,
  };
}

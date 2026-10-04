// Picking waves. Lifecycle:
//   DRAFT --release--> RELEASED --start--> IN_PROGRESS --(all tasks done: complete)--> COMPLETED
//   DRAFT / RELEASED / IN_PROGRESS --cancel--> CANCELLED   (open tasks are cancelled and their stock released)
// A wave also completes automatically when the last open task of an IN_PROGRESS wave is finished.
import { ConflictError, InvalidStateError, NotFoundError, parseInput } from "@/lib/errors";
import { deriveFulfilmentStatus } from "@/modules/orders";
import { runStockOperation } from "@/modules/inventory";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { withTransaction } from "@/server/db";
import { pickingRepo } from "../repo/pickingRepo";
import { addOrdersToWaveSchema, createWaveSchema, waveActionSchema } from "../schemas";
import type { WaveDetailDto } from "../types";
import { cancelOpenTasks } from "./taskCancellation";
import { getWave } from "./queries";

const ELIGIBLE_ORDER_STATUSES = ["PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING"];
const waveLabel = (n: number) => `W-${String(n).padStart(4, "0")}`;

export async function createWave(ctx: TenantContext, raw: unknown = {}): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const input = parseInput(createWaveSchema, raw);
  const wave = await pickingRepo(ctx).createWave(input.note ?? null);
  return getWave(ctx, wave.id);
}

/** Add the unassigned pick tasks of allocated orders to a DRAFT wave. */
export async function addOrdersToWave(ctx: TenantContext, raw: unknown): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const { waveId, orderIds } = parseInput(addOrdersToWaveSchema, raw);
  await withTransaction(async (tx) => {
    const pk = pickingRepo(ctx, tx);
    // Lock order: Wave -> Orders (ascending id) -> Tasks.
    const [wave] = await pk.lockWaves([waveId]);
    if (!wave) throw new NotFoundError("Wave not found");
    if (wave.status !== "DRAFT") throw new InvalidStateError(`Orders can only be added to a DRAFT wave (this wave is ${wave.status})`);
    const orders = await pk.lockOrders(orderIds);
    if (orders.length !== new Set(orderIds).size) throw new NotFoundError("Order not found");

    const taskIds: string[] = [];
    for (const order of orders) {
      if (!ELIGIBLE_ORDER_STATUSES.includes(order.status)) {
        throw new InvalidStateError(`Order ${order.orderNumber} is ${order.status}; only allocated orders can be added to a wave`);
      }
      const free = (await pk.taskIdsOfOrder(order.id)).filter((t) => t.waveId === null && t.status === "PENDING");
      if (free.length === 0) throw new InvalidStateError(`Order ${order.orderNumber} has no pick tasks waiting for a wave`);
      taskIds.push(...free.map((t) => t.id));
    }
    const lockedTasks = await pk.lockTasks(taskIds);
    const assignable = lockedTasks.filter((t) => t.waveId === null && t.status === "PENDING");
    if (assignable.length !== taskIds.length) throw new ConflictError("Some tasks were assigned or changed meanwhile. Please retry.");
    if ((await pk.assignTasksToWave(taskIds, waveId)) !== taskIds.length) throw new ConflictError("Some tasks could not be assigned. Please retry.");
  });
  return getWave(ctx, waveId);
}

export async function releaseWave(ctx: TenantContext, raw: unknown): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const { waveId } = parseInput(waveActionSchema, raw);
  await withTransaction(async (tx) => {
    const pk = pickingRepo(ctx, tx);
    const [wave] = await pk.lockWaves([waveId]);
    if (!wave) throw new NotFoundError("Wave not found");
    if (wave.status !== "DRAFT") throw new InvalidStateError(`Only a DRAFT wave can be released (this wave is ${wave.status})`);
    if ((await pk.openTaskCountOfWave(waveId)) === 0) throw new InvalidStateError("A wave needs at least one pick task before it can be released");
    await pk.transitionWave(waveId, ["DRAFT"], "RELEASED", "releasedAt");
  });
  return getWave(ctx, waveId);
}

/** RELEASED -> IN_PROGRESS: pickers may now confirm picks for this wave. */
export async function startWave(ctx: TenantContext, raw: unknown): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const { waveId } = parseInput(waveActionSchema, raw);
  await withTransaction(async (tx) => {
    const pk = pickingRepo(ctx, tx);
    const [wave] = await pk.lockWaves([waveId]);
    if (!wave) throw new NotFoundError("Wave not found");
    if (wave.status !== "RELEASED") throw new InvalidStateError(`Only a RELEASED wave can be started (this wave is ${wave.status})`);
    await pk.transitionWave(waveId, ["RELEASED"], "IN_PROGRESS", "startedAt");
  });
  return getWave(ctx, waveId);
}

/** IN_PROGRESS -> COMPLETED once no task is open (all completed or cancelled). */
export async function completeWave(ctx: TenantContext, raw: unknown): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const { waveId } = parseInput(waveActionSchema, raw);
  await withTransaction(async (tx) => {
    const pk = pickingRepo(ctx, tx);
    const [wave] = await pk.lockWaves([waveId]);
    if (!wave) throw new NotFoundError("Wave not found");
    if (wave.status !== "IN_PROGRESS") throw new InvalidStateError(`Only an IN_PROGRESS wave can be completed (this wave is ${wave.status})`);
    const open = await pk.openTaskCountOfWave(waveId);
    if (open > 0) throw new InvalidStateError(`${open} pick task(s) in ${waveLabel(wave.number)} are still open`);
    await pk.transitionWave(waveId, ["IN_PROGRESS"], "COMPLETED", "completedAt");
  });
  return getWave(ctx, waveId);
}

/** Cancel a wave: open tasks are cancelled, their reservations released, and affected orders recomputed. */
export async function cancelWave(ctx: TenantContext, raw: unknown): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.manage");
  const { waveId } = parseInput(waveActionSchema, raw);
  const pk0 = pickingRepo(ctx);
  const wave0 = await pk0.findWave(waveId);
  if (!wave0) throw new NotFoundError("Wave not found");
  const preTasks = await pk0.taskIdsOfWave(waveId);
  const orderIdsPre = [...new Set(preTasks.map((t) => t.orderId))];

  const work = async (stock: { releaseReservations: (ids: string[]) => Promise<number> }, tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
    const pk = pickingRepo(ctx, tx);
    // Lock order: Wave -> Orders (ascending id) -> Tasks -> Reservations -> Balances.
    const [wave] = await pk.lockWaves([waveId]);
    if (!wave) throw new NotFoundError("Wave not found");
    if (!["DRAFT", "RELEASED", "IN_PROGRESS"].includes(wave.status)) {
      throw new InvalidStateError(`A ${wave.status} wave cannot be cancelled`);
    }
    const orders = await pk.lockOrders(orderIdsPre);
    const lockedOrderIds = new Set(orders.map((o) => o.id));
    const now = await pk.taskIdsOfWave(waveId);
    if (now.some((t) => !lockedOrderIds.has(t.orderId))) throw new ConflictError("Orders were added to the wave while it was being cancelled. Please retry.");
    const tasks = await pk.lockTasks(now.map((t) => t.id));

    const { orderIds } = await cancelOpenTasks(pk, stock, tasks);
    await pk.transitionWave(waveId, ["DRAFT", "RELEASED", "IN_PROGRESS"], "CANCELLED", "cancelledAt");
    for (const order of orders) {
      // Orders already CANCELLED or PICKED keep their final status.
      if (orderIds.has(order.id) && order.status !== "CANCELLED" && order.status !== "PICKED") {
        await pk.setOrderStatus(order.id, deriveFulfilmentStatus(await pk.orderLines(order.id)));
      }
    }
  };

  if (preTasks.length === 0) {
    await withTransaction((tx) => work({ releaseReservations: async () => 0 }, tx));
  } else {
    await runStockOperation(
      ctx,
      { type: "RELEASE", request: { action: "cancel-wave", waveId }, refType: "WAVE", refId: waveId, reason: `Cancel wave ${waveLabel(wave0.number)}` },
      work,
    );
  }
  return getWave(ctx, waveId);
}

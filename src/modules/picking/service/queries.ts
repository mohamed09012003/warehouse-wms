import { NotFoundError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import type { OrderStatusName } from "@/modules/orders";
import { pickingRepo } from "../repo/pickingRepo";
import { listTasksSchema } from "../schemas";
import type { EligibleOrderDto, PickTaskDto, PickTaskStatusName, WaveDetailDto, WaveStatusName, WaveSummaryDto } from "../types";

interface TaskLike {
  id: string;
  status: PickTaskStatusName;
  waveId: string | null;
  orderId: string;
  orderLineId: string;
  productId: string;
  positionId: string;
  positionCode: string;
  quantity: number;
  pickedQty: number;
}

export function toTaskDto(
  t: TaskLike,
  extra: {
    orderNumber: string;
    orderStatus?: OrderStatusName;
    sku: string;
    productName: string;
    wave: { number: number; status: WaveStatusName } | null;
  },
): PickTaskDto {
  return {
    id: t.id,
    status: t.status,
    waveId: t.waveId,
    waveNumber: extra.wave?.number ?? null,
    waveStatus: extra.wave?.status ?? null,
    orderId: t.orderId,
    orderNumber: extra.orderNumber,
    orderStatus: extra.orderStatus,
    orderLineId: t.orderLineId,
    productId: t.productId,
    sku: extra.sku,
    productName: extra.productName,
    positionId: t.positionId,
    positionCode: t.positionCode,
    quantity: t.quantity,
    pickedQty: t.pickedQty,
    remainingQty: t.status === "CANCELLED" ? 0 : t.quantity - t.pickedQty,
  };
}

function summarizeWave(w: {
  id: string;
  number: number;
  status: WaveStatusName;
  note: string | null;
  createdAt: Date;
  tasks: { status: PickTaskStatusName; quantity: number; pickedQty: number; orderId: string }[];
}): WaveSummaryDto {
  const live = w.tasks.filter((t) => t.status !== "CANCELLED");
  const totalQuantity = live.reduce((n, t) => n + t.quantity, 0);
  const pickedQuantity = live.reduce((n, t) => n + t.pickedQty, 0);
  return {
    id: w.id,
    number: w.number,
    status: w.status,
    note: w.note,
    taskCount: live.length,
    completedTaskCount: live.filter((t) => t.status === "COMPLETED").length,
    orderCount: new Set(live.map((t) => t.orderId)).size,
    totalQuantity,
    pickedQuantity,
    progressPercent: totalQuantity === 0 ? 0 : Math.floor((pickedQuantity * 100) / totalQuantity),
    createdAt: w.createdAt.toISOString(),
  };
}

export async function listWaves(ctx: TenantContext): Promise<WaveSummaryDto[]> {
  requirePermission(ctx, "picking.view");
  return (await pickingRepo(ctx).listWaves()).map(summarizeWave);
}

export async function getWave(ctx: TenantContext, id: string): Promise<WaveDetailDto> {
  requirePermission(ctx, "picking.view");
  const w = await pickingRepo(ctx).waveWithTasks(id);
  if (!w) throw new NotFoundError("Wave not found");
  return {
    ...summarizeWave(w),
    tasks: w.tasks.map((t) => toTaskDto(t, { orderNumber: t.order.orderNumber, sku: t.product.sku, productName: t.product.name, wave: { number: w.number, status: w.status } })),
  };
}

export async function getPickTask(ctx: TenantContext, id: string): Promise<PickTaskDto> {
  requirePermission(ctx, "picking.view");
  const t = await pickingRepo(ctx).taskDetail(id);
  if (!t) throw new NotFoundError("Pick task not found");
  return toTaskDto(t, { orderNumber: t.order.orderNumber, orderStatus: t.order.status, sku: t.product.sku, productName: t.product.name, wave: t.wave });
}

export async function listPickTasks(ctx: TenantContext, raw: unknown = {}): Promise<PickTaskDto[]> {
  requirePermission(ctx, "picking.view");
  const rows = await pickingRepo(ctx).tasksList(parseInput(listTasksSchema, raw));
  return rows.map((t) => toTaskDto(t, { orderNumber: t.order.orderNumber, sku: t.product.sku, productName: t.product.name, wave: t.wave }));
}

/** Tasks created for one order (shown on the order detail page). */
export async function listTasksForOrder(ctx: TenantContext, orderId: string): Promise<PickTaskDto[]> {
  requirePermission(ctx, "picking.view");
  const pk = pickingRepo(ctx);
  const order = await pk.findOrder(orderId);
  if (!order) throw new NotFoundError("Order not found");
  const rows = await pk.tasksOfOrderDetailed(orderId);
  return rows.map((t) => toTaskDto(t, { orderNumber: order.orderNumber, orderStatus: order.status, sku: t.product.sku, productName: "", wave: t.wave }));
}

/** Allocated orders that have pick tasks not yet in any wave. */
export async function listEligibleOrders(ctx: TenantContext): Promise<EligibleOrderDto[]> {
  requirePermission(ctx, "picking.view");
  const rows = await pickingRepo(ctx).eligibleOrders();
  return rows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    pendingTaskCount: o.tasks.length,
    pendingQuantity: o.tasks.reduce((n, t) => n + t.quantity, 0),
  }));
}

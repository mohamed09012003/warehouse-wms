import { ConflictError, InvalidStateError, NotFoundError, ValidationError, parseInput } from "@/lib/errors";
import { lookupProducts } from "@/modules/catalog";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { allocationState } from "../domain/status";
import { orderRepo } from "../repo/orderRepo";
import { createOrderSchema, listOrdersSchema } from "../schemas";
import type { OrderDetailDto, OrderSummaryDto } from "../types";

type OrderRow = NonNullable<Awaited<ReturnType<ReturnType<typeof orderRepo>["findById"]>>>;

export function toSummary(o: OrderRow): OrderSummaryDto {
  const sum = (pick: (l: OrderRow["lines"][number]) => number) => o.lines.reduce((n, l) => n + pick(l), 0);
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    externalRef: o.externalRef,
    lineCount: o.lines.length,
    requestedTotal: sum((l) => l.requestedQty),
    allocatedTotal: sum((l) => l.allocatedQty),
    pickedTotal: sum((l) => l.pickedQty),
    packedTotal: sum((l) => l.packedQty),
    allocationState: allocationState(o.lines),
    createdAt: o.createdAt.toISOString(),
  };
}

export function toDetail(o: OrderRow): OrderDetailDto {
  return {
    ...toSummary(o),
    note: o.note,
    lines: o.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      productId: l.productId,
      sku: l.product.sku,
      productName: l.product.name,
      requestedQty: l.requestedQty,
      allocatedQty: l.allocatedQty,
      pickedQty: l.pickedQty,
      packedQty: l.packedQty,
      unallocatedQty: l.requestedQty - l.allocatedQty,
    })),
  };
}

export async function listOrders(ctx: TenantContext, raw: unknown = {}): Promise<OrderSummaryDto[]> {
  requirePermission(ctx, "orders.view");
  const rows = await orderRepo(ctx).list(parseInput(listOrdersSchema, raw));
  return rows.map(toSummary);
}

export async function getOrder(ctx: TenantContext, id: string): Promise<OrderDetailDto> {
  requirePermission(ctx, "orders.view");
  const order = await orderRepo(ctx).findById(id);
  if (!order) throw new NotFoundError("Order not found");
  return toDetail(order);
}

/** Create an internal order (manual entry). Products must belong to the organization and be active. */
export async function createOrder(ctx: TenantContext, raw: unknown): Promise<OrderDetailDto> {
  requirePermission(ctx, "orders.manage");
  const input = parseInput(createOrderSchema, raw);

  const products = await lookupProducts(ctx, input.lines.map((l) => l.productId));
  for (const line of input.lines) {
    const p = products.get(line.productId);
    if (!p) throw new NotFoundError("Product not found");
    if (!p.active) throw new ValidationError(`Product ${p.sku} is disabled`);
  }

  try {
    const order = await orderRepo(ctx).create({
      orderNumber: input.orderNumber,
      status: input.ready ? "READY" : "DRAFT",
      externalRef: input.externalRef ?? null,
      note: input.note ?? null,
      lines: input.lines,
    });
    return getOrder(ctx, order.id);
  } catch (error) {
    if ((error as { code?: unknown })?.code === "P2002") throw new ConflictError(`Order number "${input.orderNumber}" already exists`);
    throw error;
  }
}

/** DRAFT -> READY: the order may now be allocated. */
export async function markOrderReady(ctx: TenantContext, id: string): Promise<OrderDetailDto> {
  requirePermission(ctx, "orders.manage");
  const repo = orderRepo(ctx);
  const order = await repo.findById(id);
  if (!order) throw new NotFoundError("Order not found");
  if ((await repo.markReady(id)) === 0) throw new InvalidStateError(`Only a DRAFT order can be marked ready (this order is ${order.status})`);
  return getOrder(ctx, id);
}

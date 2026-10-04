import { NotFoundError } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { allPickedIsPacked, startBlocker, totals } from "../domain/progress";
import { packingRepo } from "../repo/packingRepo";
import type { PackableOrderDto, PackageStatusName, PackingSessionDto, PackingSessionStatusName } from "../types";

/** Orders that can be packed or are being packed (partially picked orders are listed, never hidden). */
export async function listPackableOrders(ctx: TenantContext): Promise<PackableOrderDto[]> {
  requirePermission(ctx, "packing.view");
  const rows = await packingRepo(ctx).packableOrders();
  return rows.flatMap((o) => {
    const t = totals(o.lines);
    const latest = o.packingSessions[0];
    const openSessionId = latest?.status === "OPEN" ? latest.id : null;
    // an order with nothing picked is not part of the packing queue
    if (t.picked === 0 && !openSessionId) return [];
    const blocker = openSessionId ? null : startBlocker(o.status, o.lines);
    return [
      {
        orderId: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        requestedTotal: t.requested,
        pickedTotal: t.picked,
        packedTotal: t.packed,
        remainingTotal: t.remaining,
        packageCount: o.packages.length,
        openSessionId,
        lastSessionId: latest?.id ?? null,
        canStart: !openSessionId && blocker === null,
        blockedReason: blocker,
      },
    ];
  });
}

export async function loadSession(ctx: TenantContext, sessionId: string, db?: Parameters<typeof packingRepo>[1]): Promise<PackingSessionDto> {
  const repo = packingRepo(ctx, db);
  const s = await repo.sessionWithPackages(sessionId);
  if (!s) throw new NotFoundError("Packing session not found");
  const lines = await repo.orderLines(s.orderId);
  const t = totals(lines);
  const packages = s.packages.map((p) => ({
    id: p.id,
    packageNumber: p.packageNumber,
    status: p.status as PackageStatusName,
    packageType: p.packageType,
    weightG: p.weightG,
    lengthMm: p.lengthMm,
    widthMm: p.widthMm,
    heightMm: p.heightMm,
    totalQuantity: p.items.reduce((n, i) => n + i.quantity, 0),
    items: p.items.map((i) => ({ id: i.id, orderLineId: i.orderLineId, productId: i.productId, sku: i.product.sku, productName: i.product.name, quantity: i.quantity })),
    completedAt: p.completedAt?.toISOString() ?? null,
  }));
  const openPackageCount = packages.filter((p) => p.status === "OPEN").length;
  return {
    id: s.id,
    orderId: s.orderId,
    orderNumber: s.order.orderNumber,
    orderStatus: s.order.status,
    status: s.status as PackingSessionStatusName,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    lines: lines.map((l) => ({
      orderLineId: l.id,
      productId: l.productId,
      sku: l.product.sku,
      productName: l.product.name,
      requestedQty: l.requestedQty,
      pickedQty: l.pickedQty,
      packedQty: l.packedQty,
      remainingQty: l.pickedQty - l.packedQty,
    })),
    packages,
    requestedTotal: t.requested,
    pickedTotal: t.picked,
    packedTotal: t.packed,
    remainingTotal: t.remaining,
    openPackageCount,
    canComplete:
      s.status === "OPEN" && openPackageCount === 0 && allPickedIsPacked(lines) && packages.some((p) => p.status === "COMPLETED"),
  };
}

export async function getPackingSession(ctx: TenantContext, sessionId: string): Promise<PackingSessionDto> {
  requirePermission(ctx, "packing.view");
  return loadSession(ctx, sessionId);
}

/** The most recent packing sessions of an order (newest first), for the order's packing history. */
export async function listSessionsOfOrder(ctx: TenantContext, orderId: string) {
  requirePermission(ctx, "packing.view");
  const repo = packingRepo(ctx);
  if (!(await repo.findOrder(orderId))) throw new NotFoundError("Order not found");
  const rows = await repo.sessionsOfOrder(orderId);
  return rows.map((s) => ({ id: s.id, status: s.status as PackingSessionStatusName, startedAt: s.startedAt.toISOString(), completedAt: s.completedAt?.toISOString() ?? null, packageCount: s._count.packages }));
}

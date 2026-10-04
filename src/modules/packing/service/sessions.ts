// Packing session lifecycle:   OPEN --complete--> COMPLETED      OPEN --cancel--> CANCELLED
//
//  start:    order must have picked quantity that is not packed yet and be PICKING or PICKED;
//            a fully picked order (PICKED) becomes PACKING, a partly picked one keeps its status.
//  complete: every picked unit must be in a COMPLETED package and no package may be open. The order
//            becomes PACKED only if every REQUESTED unit is picked and packed; otherwise it stays PICKING.
//  cancel:   OPEN packages are cancelled (their quantities return to "unpacked"); refused if the
//            session already has a completed package (those are immutable). The order returns from
//            PACKING to PICKED. Picking and inventory are never touched.
import { ConflictError, InvalidStateError, NotFoundError, parseInput } from "@/lib/errors";
import { lineSummaries, orderPayload, recordEvent } from "@/modules/outbox";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { allPickedIsPacked, orderFullyPacked, startBlocker, totals } from "../domain/progress";
import { packingRepo } from "../repo/packingRepo";
import { sessionActionSchema, startSessionSchema } from "../schemas";
import type { PackingResultDto } from "../types";
import { packingMutation } from "./mutation";

export async function startPacking(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { orderId, idempotencyKey } = parseInput(startSessionSchema, raw);
  if (!(await packingRepo(ctx).findOrder(orderId))) throw new NotFoundError("Order not found");

  return packingMutation(ctx, {
    scope: "packing.start",
    idempotencyKey,
    request: { orderId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      // Lock order: Order -> Session. Two simultaneous starts serialize here; the second sees the open session.
      const order = await repo.lockOrder(orderId);
      if (!order) throw new NotFoundError("Order not found");
      if (await repo.openSessionOfOrder(orderId)) throw new InvalidStateError("This order already has an open packing session.");
      const lines = await repo.orderLines(orderId);
      const blocker = startBlocker(order.status, lines);
      if (blocker) throw new InvalidStateError(blocker);

      let session;
      try {
        session = await repo.createSession(orderId);
      } catch (error) {
        // The partial unique index (one OPEN session per order) is the final backstop.
        if ((error as { code?: unknown })?.code === "P2002") throw new InvalidStateError("This order already has an open packing session.");
        throw error;
      }
      if (order.status === "PICKED") await repo.setOrderStatus(orderId, ["PICKED"], "PACKING");
      await repo.recordEvent({ sessionId: session.id, type: "SESSION_STARTED", detail: `Order ${order.orderNumber}` });
      return { sessionId: session.id };
    },
  });
}

export async function completePacking(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { sessionId, idempotencyKey } = parseInput(sessionActionSchema, raw);
  const session0 = await packingRepo(ctx).findSession(sessionId);
  if (!session0) throw new NotFoundError("Packing session not found");

  return packingMutation(ctx, {
    scope: "packing.complete",
    idempotencyKey,
    request: { sessionId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      // Lock order: Order -> Session (picking confirmations lock the order too, so picked quantities cannot change under us).
      const order = await repo.lockOrder(session0.orderId);
      const session = await repo.lockSession(sessionId);
      if (!order || !session) throw new NotFoundError("Packing session not found");
      if (session.status !== "OPEN") throw new InvalidStateError(`This packing session is already ${session.status.toLowerCase()}.`);

      const open = await repo.countOpenPackages(sessionId);
      if (open > 0) throw new InvalidStateError(`${open} package(s) are still open. Complete or remove them first.`);
      const lines = await repo.orderLines(session.orderId);
      const t = totals(lines);
      if (!allPickedIsPacked(lines)) {
        throw new InvalidStateError(t.picked === 0 ? "Nothing has been picked for this order." : `${t.remaining} picked unit(s) are not packed yet.`, { remaining: t.remaining });
      }
      if ((await repo.countCompletedPackages(sessionId)) === 0) throw new InvalidStateError("A packing session needs at least one completed package.");

      if ((await repo.closeSession(sessionId, "COMPLETED")) === 0) throw new ConflictError("The packing session changed while completing; please retry.");
      // The order is PACKED only when EVERY requested unit is picked and packed.
      if (orderFullyPacked(lines)) {
        await repo.setOrderStatus(session.orderId, ["PACKING", "PICKED", "PICKING"], "PACKED");
        // Shipment-ready data: every completed package of the order (all sessions), in the same transaction.
        const packages = await repo.completedPackagesOfOrder(session.orderId);
        await recordEvent(tx, ctx, {
          type: "order.packed",
          payload: orderPayload(order, {
            status: "PACKED",
            lines: lineSummaries(lines),
            packages: packages.map((p) => ({
              packageNumber: p.packageNumber,
              packageType: p.packageType,
              weightG: p.weightG,
              lengthMm: p.lengthMm,
              widthMm: p.widthMm,
              heightMm: p.heightMm,
              items: p.items.map((i) => ({ sku: i.product.sku, quantity: i.quantity })),
            })),
          }),
        });
      }
      await repo.recordEvent({
        sessionId,
        type: "SESSION_COMPLETED",
        quantityAfter: t.packed,
        detail: orderFullyPacked(lines) ? "Order fully packed" : "Partially picked order: packed everything picked so far",
      });
      return { sessionId };
    },
  });
}

export async function cancelPacking(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { sessionId, idempotencyKey } = parseInput(sessionActionSchema, raw);
  const session0 = await packingRepo(ctx).findSession(sessionId);
  if (!session0) throw new NotFoundError("Packing session not found");

  return packingMutation(ctx, {
    scope: "packing.cancel",
    idempotencyKey,
    request: { sessionId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const order = await repo.lockOrder(session0.orderId);
      const session = await repo.lockSession(sessionId);
      if (!order || !session) throw new NotFoundError("Packing session not found");
      if (session.status !== "OPEN") throw new InvalidStateError(`This packing session is already ${session.status.toLowerCase()}.`);
      if ((await repo.countCompletedPackages(sessionId)) > 0) {
        throw new InvalidStateError("This session has completed packages, which cannot be changed. Complete the session instead.");
      }

      // Lock order continues: Package. Open packages are cancelled and give their quantities back.
      for (const pkg of await repo.openPackagesOfSession(sessionId)) {
        await repo.lockPackage(pkg.id);
        for (const item of [...pkg.items].sort((a, b) => (a.orderLineId < b.orderLineId ? -1 : 1))) {
          if (!(await repo.decreasePacked(item.orderLineId, item.quantity))) throw new ConflictError("Packed quantities are inconsistent; the change was aborted");
        }
        await repo.closePackage(pkg.id, "CANCELLED");
        await repo.recordEvent({ sessionId, type: "PACKAGE_CANCELLED", packageId: pkg.id, detail: `Package ${pkg.packageNumber} cancelled with its session` });
      }
      await repo.closeSession(sessionId, "CANCELLED");
      // Picking is untouched: a fully picked order simply goes back to PICKED.
      await repo.setOrderStatus(session.orderId, ["PACKING"], "PICKED");
      await repo.recordEvent({ sessionId, type: "SESSION_CANCELLED" });
      return { sessionId };
    },
  });
}

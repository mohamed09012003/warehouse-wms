import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPackingInvariants, assertPickingInvariants, ctxWithRole, inventorySnapshot, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AuthorizationError, InvalidStateError, NotFoundError } from "@/lib/errors";
import { getOrder } from "@/modules/orders";
import { allocateOrder, cancelOrder } from "@/modules/picking";
import {
  addPackageItem,
  cancelPacking,
  completePackage,
  completePacking,
  createPackage,
  getPackingSession,
  listPackableOrders,
  listSessionsOfOrder,
  startPacking,
} from "..";

beforeEach(resetDatabase);

async function setup(requested = 10, stock = 10) {
  const t = await tenantWithWarehouse("ps", { bays: 3, levels: 1 });
  const prod = await makeProduct(t.ctx, "WIDGET-1");
  await stockAt(t.ctx, prod.id, t.byCode("R01-L01-B01-P01").id, stock);
  const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: requested }]);
  return { ...t, prod, order };
}
const pack = (ctx: Parameters<typeof startPacking>[0], packageId: string, qty: number) => addPackageItem(ctx, { packageId, productCode: "WIDGET-1", quantity: qty });

describe("starting a packing session", () => {
  it("starts for a fully picked order: session OPEN, order PICKED -> PACKING", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    expect((await getOrder(ctx, order.id)).status).toBe("PICKED");
    const r = await startPacking(ctx, { orderId: order.id });
    expect(r.replayed).toBe(false);
    expect(r.session).toMatchObject({ status: "OPEN", orderNumber: order.orderNumber, orderStatus: "PACKING", requestedTotal: 10, pickedTotal: 10, packedTotal: 0, remainingTotal: 10, canComplete: false });
    expect(r.session.lines).toEqual([expect.objectContaining({ sku: "WIDGET-1", requestedQty: 10, pickedQty: 10, packedQty: 0, remainingQty: 10 })]);
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    const s = await prisma.packingSession.findUniqueOrThrow({ where: { id: r.session.id } });
    expect(s).toMatchObject({ status: "OPEN", startedByUserId: ctx.userId, completedAt: null });
    await assertPackingInvariants();
  });

  it("rejects an order with nothing picked (every earlier status), a cancelled order, and unknown ids", async () => {
    const { ctx, order, prod } = await setup();
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toThrow(/picked/i); // READY
    await allocateOrder(ctx, { orderId: order.id });
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError); // ALLOCATED, picked = 0
    await cancelOrder(ctx, { orderId: order.id });
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toThrow(/cancelled/i);
    const draft = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }], { ready: false });
    await expect(startPacking(ctx, { orderId: draft.id })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(startPacking(ctx, { orderId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await prisma.packingSession.count()).toBe(0);
  });

  it("prevents a second open session for the same order (service and database)", async () => {
    const { ctx, order, org } = await setup();
    await pickOrder(ctx, order.id);
    const first = await startPacking(ctx, { orderId: order.id });
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toThrow(/already has an open packing session/);
    // the database refuses it too, whatever path writes the row
    await expect(prisma.packingSession.create({ data: { organizationId: org.organization.id, orderId: order.id } })).rejects.toMatchObject({ code: "P2002" });
    expect(await prisma.packingSession.count({ where: { status: "OPEN" } })).toBe(1);
    expect(first.session.status).toBe("OPEN");
  });

  it("an order PACKED already cannot start again; the packing queue lists it with a reason", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 10);
    await completePackage(ctx, { packageId: p.packageId });
    await completePacking(ctx, { sessionId: s.session.id });
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toThrow(/already packed/);
    const listed = (await listPackableOrders(ctx)).find((o) => o.orderId === order.id)!;
    expect(listed).toMatchObject({ status: "PACKED", pickedTotal: 10, packedTotal: 10, remainingTotal: 0, packageCount: 1, canStart: false, lastSessionId: s.session.id });
  });
});

describe("completing a packing session", () => {
  it("completes when all picked quantity is packed in completed packages; order PACKING -> PACKED", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p1.packageId!, 6);
    await completePackage(ctx, { packageId: p1.packageId });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p2.packageId!, 4);
    const ready = await completePackage(ctx, { packageId: p2.packageId });
    expect(ready.session.canComplete).toBe(true);

    const done = await completePacking(ctx, { sessionId: s.session.id });
    expect(done.session).toMatchObject({ status: "COMPLETED", orderStatus: "PACKED", packedTotal: 10, remainingTotal: 0 });
    expect(done.session.completedAt).toBeTruthy();
    expect((await prisma.packingSession.findUniqueOrThrow({ where: { id: s.session.id } })).completedByUserId).toBe(ctx.userId);
    expect(await getOrder(ctx, order.id)).toMatchObject({ status: "PACKED", packedTotal: 10 });
    await assertPackingInvariants();
    await assertPickingInvariants();
  });

  it("rejects completion with unpacked quantity, open packages, or no package at all", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    await expect(completePacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/10 picked unit\(s\) are not packed/);

    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 8);
    await completePackage(ctx, { packageId: p.packageId });
    await expect(completePacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/2 picked unit\(s\) are not packed/);

    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p2.packageId!, 2);
    await expect(completePacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/still open/); // open package, everything packed
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    expect((await prisma.packingSession.findUniqueOrThrow({ where: { id: s.session.id } })).status).toBe("OPEN");
    await assertPackingInvariants();
  });

  it("a completed session is immutable: nothing can be added, created or completed again", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 10);
    await completePackage(ctx, { packageId: p.packageId });
    await completePacking(ctx, { sessionId: s.session.id });
    await expect(createPackage(ctx, { sessionId: s.session.id })).rejects.toThrow(/completed/);
    await expect(pack(ctx, p.packageId!, 1)).rejects.toBeInstanceOf(InvalidStateError);
    await expect(completePacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/already completed/);
    await expect(cancelPacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/already completed/);
  });
});

describe("cancelling a packing session", () => {
  it("cancels open packages, frees their quantities, returns the order to PICKED, and never touches inventory or picking", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const before = await inventorySnapshot();
    const pickedBefore = (await getOrder(ctx, order.id)).lines[0].pickedQty;

    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 7);
    const r = await cancelPacking(ctx, { sessionId: s.session.id });
    expect(r.session).toMatchObject({ status: "CANCELLED", orderStatus: "PICKED", packedTotal: 0, remainingTotal: 10 });
    expect(r.session.packages[0]).toMatchObject({ status: "CANCELLED", totalQuantity: 7 }); // history kept
    expect((await getOrder(ctx, order.id)).lines[0]).toMatchObject({ pickedQty: pickedBefore, packedQty: 0 });
    expect(await inventorySnapshot()).toBe(before); // inventory byte-for-byte unchanged
    await assertPackingInvariants();

    // the order is available for another session; package numbers continue
    const again = await startPacking(ctx, { orderId: order.id });
    expect(again.session.id).not.toBe(s.session.id);
    const p2 = await createPackage(ctx, { sessionId: again.session.id });
    const detail = await getPackingSession(ctx, again.session.id);
    expect(detail.packages.map((x) => x.packageNumber)).toEqual([2]);
    expect(p2.packageId).toBeTruthy();
    expect((await listSessionsOfOrder(ctx, order.id)).map((x) => x.status)).toEqual(["OPEN", "CANCELLED"]);
  });

  it("is refused once the session has a completed package; completed packages stay immutable", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 3);
    await completePackage(ctx, { packageId: p.packageId });
    await expect(cancelPacking(ctx, { sessionId: s.session.id })).rejects.toThrow(/completed packages/);
    expect((await prisma.packingSession.findUniqueOrThrow({ where: { id: s.session.id } })).status).toBe("OPEN");
  });

  it("an order with an open packing session cannot be cancelled; after cancelling the session it can", async () => {
    const { ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    await expect(cancelOrder(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError);
    await cancelPacking(ctx, { sessionId: s.session.id });
    expect((await getOrder(ctx, order.id)).status).toBe("PICKED"); // a fully picked order is final for picking: it is not cancellable
    await expect(cancelOrder(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError);
  });
});

describe("partially picked orders", () => {
  it("can be packed for what is picked; the order stays PICKING and is never marked PACKED early", async () => {
    const { ctx, order } = await setup(10, 10);
    await pickOrder(ctx, order.id, 7); // allocated 10, picked 7
    expect(await getOrder(ctx, order.id)).toMatchObject({ status: "PICKING", pickedTotal: 7 });

    const s = await startPacking(ctx, { orderId: order.id });
    expect(s.session.orderStatus).toBe("PICKING"); // partly picked: status does not change
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await expect(pack(ctx, p.packageId!, 8)).rejects.toThrow(/Only 7/); // cannot pack more than picked
    await pack(ctx, p.packageId!, 7);
    await completePackage(ctx, { packageId: p.packageId });
    const done = await completePacking(ctx, { sessionId: s.session.id });
    expect(done.session.status).toBe("COMPLETED");
    expect(done.session.orderStatus).toBe("PICKING"); // the missing 3 are not invented
    expect(await getOrder(ctx, order.id)).toMatchObject({ status: "PICKING", pickedTotal: 7, packedTotal: 7 });

    // nothing left to pack until more is picked; the order is still listed, with the reason
    await expect(startPacking(ctx, { orderId: order.id })).rejects.toThrow(/already been packed/);
    const listed = (await listPackableOrders(ctx)).find((o) => o.orderId === order.id)!;
    expect(listed).toMatchObject({ status: "PICKING", pickedTotal: 7, packedTotal: 7, remainingTotal: 0, canStart: false });
    await assertPackingInvariants();
  });

  it("when the rest is picked later, a second session packs it and only then the order is PACKED", async () => {
    const { ctx, order } = await setup(10, 10);
    const waveId = await pickOrder(ctx, order.id, 7);
    const s1 = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s1.session.id });
    await pack(ctx, p1.packageId!, 7);
    await completePackage(ctx, { packageId: p1.packageId });
    await completePacking(ctx, { sessionId: s1.session.id });

    // pick the remaining 3 (the same wave and tasks are still open)
    const { confirmPick } = await import("@/modules/picking");
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: order.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, include: { product: true } });
    await confirmPick(ctx, { taskId: task.id, locationCode: task.positionCode, productCode: task.product.sku, quantity: 3 });
    expect((await getOrder(ctx, order.id)).status).toBe("PICKED");
    expect(waveId).toBeTruthy();

    const s2 = await startPacking(ctx, { orderId: order.id });
    expect(s2.session).toMatchObject({ orderStatus: "PACKING", remainingTotal: 3, packedTotal: 7 });
    const p2 = await createPackage(ctx, { sessionId: s2.session.id });
    expect(p2.session.packages.map((x) => x.packageNumber)).toEqual([2]); // numbering continues per order
    await pack(ctx, p2.packageId!, 3);
    await completePackage(ctx, { packageId: p2.packageId });
    const done = await completePacking(ctx, { sessionId: s2.session.id });
    expect(done.session.orderStatus).toBe("PACKED");
    expect(await getOrder(ctx, order.id)).toMatchObject({ status: "PACKED", pickedTotal: 10, packedTotal: 10 });
    await assertPackingInvariants();
    await assertPickingInvariants();
  });

  it("picking the last units while a session is open turns the order into PACKING", async () => {
    const { ctx, order } = await setup(10, 10);
    await pickOrder(ctx, order.id, 6);
    const s = await startPacking(ctx, { orderId: order.id });
    expect(s.session.orderStatus).toBe("PICKING");
    const { confirmPick } = await import("@/modules/picking");
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: order.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, include: { product: true } });
    const r = await confirmPick(ctx, { taskId: task.id, locationCode: task.positionCode, productCode: task.product.sku, quantity: 4 });
    expect(r.orderStatus).toBe("PACKING");
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await pack(ctx, p.packageId!, 10);
    await completePackage(ctx, { packageId: p.packageId });
    expect((await completePacking(ctx, { sessionId: s.session.id })).session.orderStatus).toBe("PACKED");
  });
});

describe("authorization and queue", () => {
  it("Member can view the queue and sessions but cannot start, package or pack; Admin can", async () => {
    const { org, ctx, order } = await setup();
    await pickOrder(ctx, order.id);
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    await expect(listPackableOrders(member)).resolves.toHaveLength(1);
    await expect(startPacking(member, { orderId: order.id })).rejects.toBeInstanceOf(AuthorizationError);
    const s = await startPacking(admin, { orderId: order.id });
    await expect(getPackingSession(member, s.session.id)).resolves.toBeTruthy();
    await expect(createPackage(member, { sessionId: s.session.id })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(cancelPacking(member, { sessionId: s.session.id })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("the queue lists partially picked orders and never lists an order with nothing picked", async () => {
    const { ctx, order, prod } = await setup(10, 10);
    const none = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    await pickOrder(ctx, order.id, 4);
    const queue = await listPackableOrders(ctx);
    expect(queue.map((o) => o.orderNumber)).toEqual([order.orderNumber]);
    expect(queue[0]).toMatchObject({ requestedTotal: 10, pickedTotal: 4, remainingTotal: 4, canStart: true });
    expect(none.id).toBeTruthy();
  });
});

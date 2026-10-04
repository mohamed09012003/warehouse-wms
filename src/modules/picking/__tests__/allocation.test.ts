import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPickingInvariants, ctxWithRole, makeOrder, makeProduct, prepareWave, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { ConflictError, InsufficientStockError, InvalidStateError, NotFoundError } from "@/lib/errors";
import { createReservation, listStock, releaseReservation } from "@/modules/inventory";
import { getOrder } from "@/modules/orders";
import { addOrdersToWave, allocateOrder, cancelOrder, createWave, listTasksForOrder, releaseOrderAllocation, releaseWave } from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("al", { bays: 4, levels: 2 });
  const prod = await makeProduct(t.ctx, "SOLAR-A");
  return { ...t, prod, B1: t.byCode("R01-L01-B01-P01"), B2: t.byCode("R01-L01-B02-P01"), B3: t.byCode("R01-L01-B03-P01"), L2: t.byCode("R01-L02-B01-P01") };
}
const balance = (positionId: string, productId: string) => prisma.inventoryBalance.findFirstOrThrow({ where: { positionId, productId } });

describe("allocating a fully available order", () => {
  it("reserves across positions in physical order (5 from the first, 3 from the second) and creates one task per reservation", async () => {
    const { ctx, prod, B1, B2 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    await stockAt(ctx, prod.id, B2.id, 7);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 8 }]);

    const r = await allocateOrder(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "ALLOCATED", allocationState: "FULL", requestedTotal: 8, allocatedTotal: 8, allocatedNow: 8, tasksCreated: 2, replayed: false });

    const tasks = await prisma.pickTask.findMany({ where: { orderId: order.id }, orderBy: { positionCode: "asc" } });
    expect(tasks.map((t) => [t.positionCode, t.quantity, t.pickedQty, t.status, t.waveId])).toEqual([
      ["R01-L01-B01-P01", 5, 0, "PENDING", null],
      ["R01-L01-B02-P01", 3, 0, "PENDING", null],
    ]);
    expect(tasks.map((t) => t.positionId)).toEqual([B1.id, B2.id]); // the real Position ids are authoritative

    // reservations exist through the inventory mechanism: one per task, linked to the order line
    const reservations = await prisma.reservation.findMany({ where: { refType: "ORDER_LINE", refId: order.lines[0].id }, include: { lines: true } });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((x) => x.status === "ACTIVE" && x.lines.length === 1)).toBe(true);
    expect(tasks.every((t) => reservations.some((x) => x.id === t.reservationId && x.lines[0].id === t.reservationLineId))).toBe(true);

    // stock: reserved 5 and 3, nothing consumed, available reduced
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 5, reserved: 5 });
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 7, reserved: 3 });
    const stock = await listStock(ctx);
    expect(stock.map((s) => [s.positionCode, s.available])).toEqual([["R01-L01-B01-P01", 0], ["R01-L01-B02-P01", 4]]);

    // the order line records it, and the ledger recorded RESERVE movements
    const line = (await getOrder(ctx, order.id)).lines[0];
    expect([line.requestedQty, line.allocatedQty, line.pickedQty, line.unallocatedQty]).toEqual([8, 8, 0, 0]);
    expect(await prisma.inventoryMovement.count({ where: { type: "RESERVE" } })).toBe(2);
    await assertPickingInvariants();
  });

  it("is deterministic by physical position, not by creation order or id", async () => {
    const { ctx, prod, B1, B3, L2 } = await setup();
    // stock received in the "wrong" order: level 2 first, then bay 3, then bay 1
    await stockAt(ctx, prod.id, L2.id, 4);
    await stockAt(ctx, prod.id, B3.id, 4);
    await stockAt(ctx, prod.id, B1.id, 4);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 6 }]);
    await allocateOrder(ctx, { orderId: order.id });
    const tasks = await listTasksForOrder(ctx, order.id);
    // rack, then level, then bay: L01-B01, L01-B03, then L02
    expect(tasks.map((t) => [t.positionCode, t.quantity])).toEqual([["R01-L01-B01-P01", 4], ["R01-L01-B03-P01", 2]]);
  });

  it("allocates every line of a multi-line order and ignores positions holding a different product", async () => {
    const { ctx, prod, B1, B2, B3 } = await setup();
    const other = await makeProduct(ctx, "PANEL-B");
    await stockAt(ctx, other.id, B1.id, 100); // different product sits first in the rack
    await stockAt(ctx, prod.id, B2.id, 10);
    await stockAt(ctx, other.id, B3.id, 6);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }, { productId: other.id, quantity: 8 }]);
    await allocateOrder(ctx, { orderId: order.id });
    const tasks = await listTasksForOrder(ctx, order.id);
    expect(tasks.map((t) => [t.sku, t.positionCode, t.quantity]).sort()).toEqual(
      [["PANEL-B", "R01-L01-B01-P01", 8], ["SOLAR-A", "R01-L01-B02-P01", 4]].sort(),
    );
    // never a task against a position holding another product
    for (const t of await prisma.pickTask.findMany()) {
      const b = await balance(t.positionId, t.productId);
      expect(b.onHand).toBeGreaterThan(0);
    }
  });

  it("only READY (or partially allocated / picking) orders can be allocated; a full order cannot be allocated again", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 10);
    const draft = await makeOrder(ctx, [{ productId: prod.id, quantity: 2 }], { ready: false });
    await expect(allocateOrder(ctx, { orderId: draft.id })).rejects.toBeInstanceOf(InvalidStateError);
    const ready = await makeOrder(ctx, [{ productId: prod.id, quantity: 2 }]);
    await allocateOrder(ctx, { orderId: ready.id });
    await expect(allocateOrder(ctx, { orderId: ready.id })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(allocateOrder(ctx, { orderId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("partial allocation and shortage", () => {
  it("allocates what exists, leaves the rest unallocated, and creates tasks only for reserved stock", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 8 }]);
    const r = await allocateOrder(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "PARTIALLY_ALLOCATED", allocationState: "PARTIAL", requestedTotal: 8, allocatedTotal: 5, allocatedNow: 5, tasksCreated: 1 });
    const line = (await getOrder(ctx, order.id)).lines[0];
    expect([line.allocatedQty, line.unallocatedQty]).toEqual([5, 3]);
    expect(await prisma.pickTask.aggregate({ _sum: { quantity: true } })).toMatchObject({ _sum: { quantity: 5 } });
    await assertPickingInvariants();
  });

  it("allocating again later tops up the remainder (new reservation and task) once stock arrives", async () => {
    const { ctx, prod, B1, B2 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 8 }]);
    await allocateOrder(ctx, { orderId: order.id });
    await stockAt(ctx, prod.id, B2.id, 10);
    const r = await allocateOrder(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "ALLOCATED", allocationState: "FULL", allocatedTotal: 8, allocatedNow: 3, tasksCreated: 1 });
    expect((await listTasksForOrder(ctx, order.id)).map((t) => [t.positionCode, t.quantity])).toEqual([["R01-L01-B01-P01", 5], ["R01-L01-B02-P01", 3]]);
    await assertPickingInvariants();
  });

  it("no stock at all: INSUFFICIENT_STOCK, nothing reserved, no tasks, no ledger entries, status unchanged", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 3 }]);
    await expect(allocateOrder(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await getOrder(ctx, order.id)).status).toBe("READY");
    expect(await prisma.pickTask.count()).toBe(0);
    expect(await prisma.reservation.count()).toBe(0);
    expect(await prisma.inventoryOperation.count()).toBe(0);
  });

  it("reserved stock is not available: a second order only gets what is left, and never the first order's stock", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 10);
    const o1 = await makeOrder(ctx, [{ productId: prod.id, quantity: 7 }]);
    const o2 = await makeOrder(ctx, [{ productId: prod.id, quantity: 7 }]);
    await allocateOrder(ctx, { orderId: o1.id });
    const r2 = await allocateOrder(ctx, { orderId: o2.id });
    expect(r2).toMatchObject({ status: "PARTIALLY_ALLOCATED", allocatedTotal: 3 });
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 10, reserved: 10 });
    // a manual reservation also reduces what can be allocated
    const o3 = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    await expect(allocateOrder(ctx, { orderId: o3.id })).rejects.toBeInstanceOf(InsufficientStockError);
    await assertPickingInvariants();
  });

  it("stock held by a manual (non-order) reservation is not allocated", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 10);
    await createReservation(ctx, { lines: [{ productId: prod.id, positionId: B1.id, quantity: 9 }] });
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }]);
    expect((await allocateOrder(ctx, { orderId: order.id })).allocatedTotal).toBe(1);
  });
});

describe("releasing an allocation and cancelling", () => {
  it("release allocation: tasks cancelled, reservations released through inventory (RELEASE movements), order back to READY", async () => {
    const { ctx, prod, B1, B2 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    await stockAt(ctx, prod.id, B2.id, 7);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 8 }]);
    await allocateOrder(ctx, { orderId: order.id });

    const r = await releaseOrderAllocation(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "READY", tasksCancelled: 2 });
    expect((await prisma.pickTask.findMany()).every((t) => t.status === "CANCELLED")).toBe(true);
    const reservations = await prisma.reservation.findMany();
    expect(reservations.every((x) => x.status === "RELEASED" && x.releasedAt)).toBe(true); // history kept, not deleted
    expect(reservations).toHaveLength(2);
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 5, reserved: 0 });
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 7, reserved: 0 });
    expect((await getOrder(ctx, order.id)).lines[0]).toMatchObject({ allocatedQty: 0, pickedQty: 0 });
    expect(await prisma.inventoryMovement.count({ where: { type: "RELEASE" } })).toBe(2);
    await assertPickingInvariants();

    // and it can be allocated again
    expect((await allocateOrder(ctx, { orderId: order.id })).status).toBe("ALLOCATED");
  });

  it("an allocated order sitting in a released wave must leave the wave first", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }]);
    await allocateOrder(ctx, { orderId: order.id });
    const wave = await createWave(ctx, {});
    await addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] });
    await releaseWave(ctx, { waveId: wave.id });
    await expect(releaseOrderAllocation(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError);
    expect((await getOrder(ctx, order.id)).status).toBe("ALLOCATED");
  });

  it("cancel releases the remaining reservation, keeps history, and the stock becomes allocatable again", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 6);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 6 }]);
    await allocateOrder(ctx, { orderId: order.id });
    const r = await cancelOrder(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "CANCELLED", tasksCancelled: 1 });
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 6, reserved: 0 });
    expect((await prisma.reservation.findMany()).map((x) => x.status)).toEqual(["RELEASED"]);
    await expect(allocateOrder(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(cancelOrder(ctx, { orderId: order.id })).rejects.toBeInstanceOf(InvalidStateError);
    const next = await makeOrder(ctx, [{ productId: prod.id, quantity: 6 }]);
    expect((await allocateOrder(ctx, { orderId: next.id })).status).toBe("ALLOCATED");
    await assertPickingInvariants();
  });

  it("DRAFT and READY orders (no reservations) can be cancelled without touching the ledger", async () => {
    const { ctx, prod } = await setup();
    const draft = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }], { ready: false });
    const ready = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    expect((await cancelOrder(ctx, { orderId: draft.id })).status).toBe("CANCELLED");
    expect((await cancelOrder(ctx, { orderId: ready.id })).status).toBe("CANCELLED");
    expect(await prisma.inventoryOperation.count()).toBe(0);
  });

  it("order-managed reservations cannot be released directly through inventory", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }]);
    await allocateOrder(ctx, { orderId: order.id });
    const reservation = await prisma.reservation.findFirstOrThrow();
    await expect(releaseReservation(ctx, { reservationId: reservation.id })).rejects.toBeInstanceOf(ConflictError);
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: reservation.id } })).status).toBe("ACTIVE");
  });
});

describe("authorization and idempotency", () => {
  it("Member cannot allocate, release or cancel; Admin can", async () => {
    const { org, ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }]);
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    await expect(allocateOrder(member, { orderId: order.id })).rejects.toThrow(/permission/i);
    await expect(releaseOrderAllocation(member, { orderId: order.id })).rejects.toThrow(/permission/i);
    await expect(cancelOrder(member, { orderId: order.id })).rejects.toThrow(/permission/i);
    await expect(allocateOrder(admin, { orderId: order.id })).resolves.toMatchObject({ status: "ALLOCATED" });
  });

  it("a keyed allocation is applied once; replay returns the same outcome", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 10);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }]);
    const first = await allocateOrder(ctx, { orderId: order.id, idempotencyKey: "alloc-key-0001" });
    const again = await allocateOrder(ctx, { orderId: order.id, idempotencyKey: "alloc-key-0001" });
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(await prisma.pickTask.count()).toBe(1);
    expect(await balance(B1.id, prod.id)).toMatchObject({ reserved: 4 });
  });

  it("prepareWave helper end state is consistent (sanity for later suites)", async () => {
    const { ctx, prod, B1 } = await setup();
    await stockAt(ctx, prod.id, B1.id, 5);
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }]);
    const waveId = await prepareWave(ctx, [order.id]);
    expect((await prisma.pickingWave.findUniqueOrThrow({ where: { id: waveId } })).status).toBe("IN_PROGRESS");
  });
});

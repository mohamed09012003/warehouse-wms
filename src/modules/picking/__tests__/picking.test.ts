import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPickingInvariants, ctxWithRole, makeOrder, makeProduct, prepareWave, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import {
  AuthorizationError,
  InvalidStateError,
  NotFoundError,
  PickQuantityError,
  ReservationUnavailableError,
  TaskNotPickableError,
  ValidationError,
  WrongLocationError,
  WrongProductError,
} from "@/lib/errors";
import { addBarcode } from "@/modules/catalog";
import { adjustStock, listMovements, moveStock } from "@/modules/inventory";
import { getOrder } from "@/modules/orders";
import {
  addOrdersToWave,
  allocateOrder,
  cancelOrder,
  cancelWave,
  completeWave,
  confirmPick,
  createWave,
  getWave,
  listEligibleOrders,
  listPickTasks,
  listWaves,
  releaseWave,
  startWave,
} from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("pk", { bays: 4, levels: 2 });
  const prod = await makeProduct(t.ctx, "SOLAR-A");
  const B1 = t.byCode("R01-L01-B01-P01");
  const B2 = t.byCode("R01-L01-B02-P01");
  await stockAt(t.ctx, prod.id, B1.id, 5);
  await stockAt(t.ctx, prod.id, B2.id, 7);
  const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: 8 }]);
  return { ...t, prod, B1, B2, order };
}
const balance = (positionId: string, productId: string) => prisma.inventoryBalance.findFirstOrThrow({ where: { positionId, productId } });
const taskAt = async (code: string) => prisma.pickTask.findFirstOrThrow({ where: { positionCode: code } });
const pickReq = (task: { id: string; positionCode: string }, sku: string, quantity: number, extra: object = {}) => ({
  taskId: task.id,
  locationCode: task.positionCode,
  productCode: sku,
  quantity,
  ...extra,
});

describe("a valid pick", () => {
  it("consumes reserved stock, writes a PICK movement, and updates task, order line, order and wave", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    const waveId = await prepareWave(ctx, [order.id]);
    const t1 = await taskAt(B1.code);

    const r = await confirmPick(ctx, pickReq(t1, "SOLAR-A", 5));
    expect(r.replayed).toBe(false);
    expect(r.task).toMatchObject({ status: "COMPLETED", pickedQty: 5, remainingQty: 0, positionCode: B1.code, sku: "SOLAR-A" });
    expect(r).toMatchObject({ orderStatus: "PICKING", waveStatus: "IN_PROGRESS", onHandAfter: 0, reservedAfter: 0 });

    // stock: onHand AND reserved decreased by the picked quantity
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 0, reserved: 0 });
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 7, reserved: 3 }); // untouched

    // ledger: one PICK row, negative on-hand and reserved deltas, snapshot code, actor, order reason
    const pick = (await listMovements(ctx, { limit: 50 })).filter((m) => m.type === "PICK");
    expect(pick).toHaveLength(1);
    expect(pick[0]).toMatchObject({ qtyDelta: -5, reservedDelta: -5, onHandAfter: 0, reservedAfter: 0, positionCode: B1.code, sku: "SOLAR-A", actorName: expect.any(String) });
    expect(pick[0].reason).toContain(order.orderNumber);

    // reservation fully consumed -> CONSUMED (kept, not deleted); consumed quantity recorded
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: t1.reservationId }, include: { lines: true } });
    expect(reservation.status).toBe("CONSUMED");
    expect(reservation.consumedAt).toBeTruthy();
    expect(reservation.lines[0]).toMatchObject({ quantity: 5, consumedQuantity: 5 });

    // order line and order
    expect((await getOrder(ctx, order.id)).lines[0]).toMatchObject({ requestedQty: 8, allocatedQty: 8, pickedQty: 5 });
    expect((await getOrder(ctx, order.id)).status).toBe("PICKING");
    expect((await getWave(ctx, waveId)).status).toBe("IN_PROGRESS"); // second task still open
    await assertPickingInvariants();
  });

  it("finishing the last task completes the order (PICKED) and the wave automatically", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    const waveId = await prepareWave(ctx, [order.id]);
    await confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 5));
    const last = await confirmPick(ctx, pickReq(await taskAt(B2.code), "SOLAR-A", 3));
    expect(last).toMatchObject({ orderStatus: "PICKED", waveStatus: "COMPLETED" });
    const o = await getOrder(ctx, order.id);
    expect(o.status).toBe("PICKED");
    expect(o.lines[0]).toMatchObject({ requestedQty: 8, allocatedQty: 8, pickedQty: 8 });
    const wave = await getWave(ctx, waveId);
    expect(wave).toMatchObject({ status: "COMPLETED", progressPercent: 100, completedTaskCount: 2 });
    expect(await prisma.pickingWave.findUniqueOrThrow({ where: { id: waveId } })).toMatchObject({ completedAt: expect.any(Date) });
    // stock left: 4 at B2 (7 - 3), nothing reserved, nothing active
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 4, reserved: 0 });
    expect(await prisma.reservation.count({ where: { status: "ACTIVE" } })).toBe(0);
    await assertPickingInvariants();
  });

  it("a task can be picked in several partial confirmations (IN_PROGRESS until complete)", async () => {
    const { ctx, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    expect((await confirmPick(ctx, pickReq(t, "SOLAR-A", 2))).task).toMatchObject({ status: "IN_PROGRESS", pickedQty: 2, remainingQty: 3 });
    expect((await confirmPick(ctx, pickReq(t, "SOLAR-A", 2))).task).toMatchObject({ status: "IN_PROGRESS", pickedQty: 4, remainingQty: 1 });
    expect((await confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).task).toMatchObject({ status: "COMPLETED", pickedQty: 5 });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: t.reservationId } });
    expect(reservation.status).toBe("CONSUMED");
    await assertPickingInvariants();
  });

  it("the product may be confirmed by SKU (any case) or by a barcode", async () => {
    const { ctx, prod, B1, order } = await setup();
    await addBarcode(ctx, prod.id, { barcode: "4006381333931" });
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await confirmPick(ctx, pickReq(t, "solar-a", 1));
    await confirmPick(ctx, pickReq(t, "4006381333931", 1));
    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: t.id } })).pickedQty).toBe(2);
  });

  it("the location may be typed in lower case", async () => {
    const { ctx, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await expect(confirmPick(ctx, { taskId: t.id, locationCode: ` ${B1.code.toLowerCase()} `, productCode: "SOLAR-A", quantity: 1 })).resolves.toBeTruthy();
  });
});

describe("invalid picks are rejected and change nothing", () => {
  async function untouched(ctx: Awaited<ReturnType<typeof setup>>["ctx"], expectedPicked = 0) {
    expect(await prisma.pickTask.aggregate({ _sum: { pickedQty: true } })).toMatchObject({ _sum: { pickedQty: expectedPicked } });
    expect(await prisma.inventoryMovement.count({ where: { type: "PICK" } })).toBe(expectedPicked > 0 ? 1 : 0);
    await assertPickingInvariants();
    void ctx;
  }

  it("wrong location (another real position, or a code that does not exist)", async () => {
    const { ctx, B1, B2, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await expect(confirmPick(ctx, { ...pickReq(t, "SOLAR-A", 1), locationCode: B2.code })).rejects.toBeInstanceOf(WrongLocationError);
    await expect(confirmPick(ctx, { ...pickReq(t, "SOLAR-A", 1), locationCode: "R99-L01-B01-P01" })).rejects.toBeInstanceOf(WrongLocationError);
    const err = await confirmPick(ctx, { ...pickReq(t, "SOLAR-A", 1), locationCode: B2.code }).catch((e) => e);
    expect(err.code).toBe("WRONG_LOCATION");
    expect(err.message).toContain(B1.code);
    await untouched(ctx);
  });

  it("wrong product (another product's SKU, or an unknown code)", async () => {
    const { ctx, B1, order } = await setup();
    await makeProduct(ctx, "OTHER-1");
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await expect(confirmPick(ctx, pickReq(t, "OTHER-1", 1))).rejects.toBeInstanceOf(WrongProductError);
    await expect(confirmPick(ctx, pickReq(t, "NO-SUCH-CODE", 1))).rejects.toBeInstanceOf(WrongProductError);
    await untouched(ctx);
  });

  it("invalid quantities: zero, negative, fractional, text, missing", async () => {
    const { ctx, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    for (const quantity of [0, -1, 1.5, "2", null, undefined]) {
      await expect(confirmPick(ctx, { ...pickReq(t, "SOLAR-A", 1), quantity })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(confirmPick(ctx, { taskId: "not-a-uuid", locationCode: "x", productCode: "y", quantity: 1 })).rejects.toBeInstanceOf(ValidationError);
    await untouched(ctx);
  });

  it("quantity above what is left on the task is rejected; picked can never exceed the task or the order", async () => {
    const { ctx, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code); // task quantity 5
    const err = await confirmPick(ctx, pickReq(t, "SOLAR-A", 6)).catch((e) => e);
    expect(err).toBeInstanceOf(PickQuantityError);
    expect(err.message).toContain("5");
    await confirmPick(ctx, pickReq(t, "SOLAR-A", 3));
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 3))).rejects.toBeInstanceOf(PickQuantityError); // only 2 left
    await untouched(ctx, 3);
  });

  it("a completed task cannot be completed twice; a cancelled task cannot be picked", async () => {
    const { ctx, B1, B2, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await confirmPick(ctx, pickReq(t, "SOLAR-A", 5));
    const err = await confirmPick(ctx, pickReq(t, "SOLAR-A", 1)).catch((e) => e);
    expect(err).toBeInstanceOf(TaskNotPickableError);
    expect(err.message).toMatch(/already completed/);
    await prisma.pickTask.update({ where: { id: (await taskAt(B2.code)).id }, data: { status: "CANCELLED" } });
    await expect(confirmPick(ctx, pickReq(await taskAt(B2.code), "SOLAR-A", 1))).rejects.toThrow(/cancelled/);
    await untouched(ctx, 5);
  });

  it("picking requires the task to be in a started wave", async () => {
    const { ctx, B1, order } = await setup();
    await allocateOrder(ctx, { orderId: order.id });
    const t = await taskAt(B1.code);
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).rejects.toThrow(/not in a wave/);
    const wave = await createWave(ctx, {});
    await addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] });
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).rejects.toThrow(/DRAFT/);
    await releaseWave(ctx, { waveId: wave.id });
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).rejects.toThrow(/RELEASED/);
    await startWave(ctx, { waveId: wave.id });
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).resolves.toBeTruthy();
  });

  it("RESERVATION_UNAVAILABLE when the reservation no longer holds the stock; the whole pick rolls back", async () => {
    const { ctx, prod, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    // simulate the reservation having been used up elsewhere
    await prisma.reservationLine.update({ where: { id: t.reservationLineId }, data: { consumedQuantity: 5 } });
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 1))).rejects.toBeInstanceOf(ReservationUnavailableError);
    // and when the reservation itself is no longer ACTIVE
    await prisma.reservationLine.update({ where: { id: t.reservationLineId }, data: { consumedQuantity: 0 } });
    await prisma.reservation.update({ where: { id: t.reservationId }, data: { status: "RELEASED" } });
    const err = await confirmPick(ctx, pickReq(t, "SOLAR-A", 1)).catch((e) => e);
    expect(err).toBeInstanceOf(ReservationUnavailableError);
    expect(err.message).toMatch(/released/);
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 5, reserved: 5 });
    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: t.id } })).pickedQty).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { type: "PICK" } })).toBe(0);
  });

  it("reserved stock cannot be taken away by moves or adjustments while a pick is pending", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    await prepareWave(ctx, [order.id]);
    await expect(adjustStock(ctx, { productId: prod.id, positionId: B1.id, delta: -1, reason: "x" })).rejects.toThrow(/Not enough available/);
    await expect(moveStock(ctx, { productId: prod.id, fromPositionId: B1.id, toPositionId: B2.id, quantity: 1 })).rejects.toThrow(/Not enough available/);
    await expect(confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 5))).resolves.toBeTruthy();
  });
});

describe("idempotency", () => {
  it("the same key applied twice consumes stock once and returns the original result", async () => {
    const { ctx, prod, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    const req = pickReq(t, "SOLAR-A", 2, { idempotencyKey: "pick-key-000001" });
    const first = await confirmPick(ctx, req);
    const again = await confirmPick(ctx, req);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.operationId).toBe(first.operationId);
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 3, reserved: 3 });
    expect(await prisma.inventoryMovement.count({ where: { type: "PICK" } })).toBe(1);
    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: t.id } })).pickedQty).toBe(2);
  });

  it("the same key with a different request is a conflict", async () => {
    const { ctx, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const t = await taskAt(B1.code);
    await confirmPick(ctx, pickReq(t, "SOLAR-A", 2, { idempotencyKey: "pick-key-000002" }));
    await expect(confirmPick(ctx, pickReq(t, "SOLAR-A", 3, { idempotencyKey: "pick-key-000002" }))).rejects.toThrow(/idempotency key/i);
  });
});

describe("waves", () => {
  it("lifecycle: create, add allocated orders, release, start, complete; each step only from the right status", async () => {
    const { ctx, B1, order } = await setup();
    await allocateOrder(ctx, { orderId: order.id });
    expect((await listEligibleOrders(ctx)).map((o) => [o.orderNumber, o.pendingTaskCount, o.pendingQuantity])).toEqual([[order.orderNumber, 2, 8]]);

    const wave = await createWave(ctx, { note: "morning" });
    expect(wave).toMatchObject({ status: "DRAFT", number: 1, taskCount: 0, note: "morning" });
    await expect(releaseWave(ctx, { waveId: wave.id })).rejects.toBeInstanceOf(InvalidStateError); // empty
    await expect(startWave(ctx, { waveId: wave.id })).rejects.toBeInstanceOf(InvalidStateError);

    const added = await addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] });
    expect(added).toMatchObject({ taskCount: 2, orderCount: 1, totalQuantity: 8, pickedQuantity: 0, progressPercent: 0 });
    expect(await listEligibleOrders(ctx)).toEqual([]); // nothing left to add
    await expect(addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] })).rejects.toBeInstanceOf(InvalidStateError);

    expect((await releaseWave(ctx, { waveId: wave.id })).status).toBe("RELEASED");
    await expect(releaseWave(ctx, { waveId: wave.id })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] })).rejects.toBeInstanceOf(InvalidStateError);
    expect((await startWave(ctx, { waveId: wave.id })).status).toBe("IN_PROGRESS");
    await expect(completeWave(ctx, { waveId: wave.id })).rejects.toThrow(/still open/);

    await confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 5));
    expect((await getWave(ctx, wave.id)).progressPercent).toBe(62);
    expect((await listWaves(ctx))[0]).toMatchObject({ number: 1, taskCount: 2, completedTaskCount: 1 });
    expect((await listPickTasks(ctx, { waveId: wave.id, status: "COMPLETED" }))).toHaveLength(1);
  });

  it("only allocated orders can join a wave; wave numbers increase per organization", async () => {
    const { ctx, prod, order } = await setup();
    await expect(addOrdersToWave(ctx, { waveId: (await createWave(ctx, {})).id, orderIds: [order.id] })).rejects.toBeInstanceOf(InvalidStateError); // READY, not allocated
    const w2 = await createWave(ctx, {});
    expect(w2.number).toBe(2);
    const draft = await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }], { ready: false });
    await expect(addOrdersToWave(ctx, { waveId: w2.id, orderIds: [draft.id] })).rejects.toBeInstanceOf(InvalidStateError);
    await expect(addOrdersToWave(ctx, { waveId: w2.id, orderIds: ["00000000-0000-4000-8000-000000000000"] })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("cancelling a wave cancels its open tasks, releases their reservations and returns orders to a consistent status", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    const waveId = await prepareWave(ctx, [order.id]);
    await confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 2)); // partially picked
    const w = await cancelWave(ctx, { waveId });
    expect(w.status).toBe("CANCELLED");
    // task 1 (2 of 5 picked): cancelled, its remaining 3 released; task 2 cancelled and fully released
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 7, reserved: 0 });
    expect((await prisma.pickTask.findMany()).every((t) => t.status === "CANCELLED")).toBe(true);
    const o = await getOrder(ctx, order.id);
    expect(o.lines[0]).toMatchObject({ allocatedQty: 2, pickedQty: 2 }); // picked stock stays consumed
    expect(o.status).toBe("PICKING");
    expect((await prisma.reservation.findMany()).every((r) => r.status !== "ACTIVE")).toBe(true);
    await assertPickingInvariants();
    await expect(cancelWave(ctx, { waveId })).rejects.toBeInstanceOf(InvalidStateError);
    // the rest of the order can be allocated again
    expect((await allocateOrder(ctx, { orderId: order.id })).allocatedTotal).toBe(8);
  });

  it("cancelling an order that is being picked keeps what was picked, releases the rest, and completes the wave", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    const waveId = await prepareWave(ctx, [order.id]);
    await confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 5));
    const r = await cancelOrder(ctx, { orderId: order.id });
    expect(r).toMatchObject({ status: "CANCELLED", tasksCancelled: 1 });
    expect(await balance(B1.id, prod.id)).toMatchObject({ onHand: 0, reserved: 0 });
    expect(await balance(B2.id, prod.id)).toMatchObject({ onHand: 7, reserved: 0 });
    expect((await getOrder(ctx, order.id)).lines[0]).toMatchObject({ allocatedQty: 5, pickedQty: 5 });
    expect((await getWave(ctx, waveId)).status).toBe("COMPLETED"); // no open task left
    await assertPickingInvariants();
  });

  it("two orders in one wave: both are picked and the wave completes only after the last task", async () => {
    const { ctx, prod, B1, B2, order } = await setup();
    const other = await makeOrder(ctx, [{ productId: prod.id, quantity: 2 }]);
    const waveId = await prepareWave(ctx, [order.id, other.id]);
    const tasks = await prisma.pickTask.findMany({ orderBy: [{ positionCode: "asc" }, { quantity: "desc" }] });
    expect(tasks.reduce((n, t) => n + t.quantity, 0)).toBe(10);
    for (const t of tasks) {
      expect((await getWave(ctx, waveId)).status).toBe("IN_PROGRESS");
      await confirmPick(ctx, pickReq(t, "SOLAR-A", t.quantity));
    }
    expect((await getWave(ctx, waveId)).status).toBe("COMPLETED");
    expect((await getOrder(ctx, order.id)).status).toBe("PICKED");
    expect((await getOrder(ctx, other.id)).status).toBe("PICKED");
    expect([B1, B2].length).toBe(2);
    await assertPickingInvariants();
  });
});

describe("partial allocation through picking", () => {
  it("a partially allocated order stays PICKING (not PICKED) after its allocated stock is picked; topping up lets it finish", async () => {
    const t = await tenantWithWarehouse("pa", { bays: 3, levels: 1 });
    const prod = await makeProduct(t.ctx, "PART-1");
    const P1 = t.byCode("R01-L01-B01-P01");
    const P2 = t.byCode("R01-L01-B02-P01");
    await stockAt(t.ctx, prod.id, P1.id, 3);
    const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: 5 }]);
    const waveId = await prepareWave(t.ctx, [order.id]);
    expect(await getOrder(t.ctx, order.id)).toMatchObject({ status: "PARTIALLY_ALLOCATED", allocationState: "PARTIAL" });

    const r = await confirmPick(t.ctx, pickReq(await taskAt(P1.code), "PART-1", 3));
    expect(r).toMatchObject({ orderStatus: "PICKING", waveStatus: "COMPLETED" });
    expect((await getOrder(t.ctx, order.id)).lines[0]).toMatchObject({ requestedQty: 5, allocatedQty: 3, pickedQty: 3, unallocatedQty: 2 });

    // stock arrives; top-up allocation while the order is PICKING creates a new task
    await stockAt(t.ctx, prod.id, P2.id, 10);
    expect(await allocateOrder(t.ctx, { orderId: order.id })).toMatchObject({ status: "PICKING", allocatedTotal: 5, allocatedNow: 2 });
    const wave2 = await createWave(t.ctx, {});
    await addOrdersToWave(t.ctx, { waveId: wave2.id, orderIds: [order.id] });
    await releaseWave(t.ctx, { waveId: wave2.id });
    await startWave(t.ctx, { waveId: wave2.id });
    const done = await confirmPick(t.ctx, pickReq(await taskAt(P2.code), "PART-1", 2));
    expect(done.orderStatus).toBe("PICKED");
    await assertPickingInvariants();
    void waveId;
  });
});

describe("permissions", () => {
  it("Member can view picking data but cannot manage waves or confirm picks", async () => {
    const { org, ctx, B1, order } = await setup();
    const waveId = await prepareWave(ctx, [order.id]);
    const member = await ctxWithRole(org, "Member");
    await expect(listWaves(member)).resolves.toHaveLength(1);
    await expect(getWave(member, waveId)).resolves.toBeTruthy();
    await expect(listPickTasks(member)).resolves.toHaveLength(2);
    await expect(createWave(member, {})).rejects.toBeInstanceOf(AuthorizationError);
    await expect(startWave(member, { waveId })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(confirmPick(member, pickReq(await taskAt(B1.code), "SOLAR-A", 1))).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("database constraints on picking tables", () => {
  it("refuse picked > quantity, a COMPLETED task that is not fully picked, and a PENDING task with picks", async () => {
    const { ctx, B1, order } = await setup();
    await allocateOrder(ctx, { orderId: order.id });
    const t = await taskAt(B1.code);
    await expect(prisma.pickTask.update({ where: { id: t.id }, data: { pickedQty: 6 } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.update({ where: { id: t.id }, data: { status: "COMPLETED" } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.update({ where: { id: t.id }, data: { pickedQty: 2 } })).rejects.toBeTruthy(); // PENDING with picks
    await prisma.pickTask.update({ where: { id: t.id }, data: { pickedQty: 2, status: "IN_PROGRESS" } }); // legal
  });

  it("a PICK movement must lower on-hand and reserved by the same amount; the ledger stays append-only", async () => {
    const { ctx, org, prod, B1, order } = await setup();
    await prepareWave(ctx, [order.id]);
    await confirmPick(ctx, pickReq(await taskAt(B1.code), "SOLAR-A", 1));
    const m = await prisma.inventoryMovement.findFirstOrThrow({ where: { type: "PICK" } });
    const base = { organizationId: org.organization.id, operationId: m.operationId, warehouseId: m.warehouseId, productId: prod.id, positionId: B1.id, positionCode: B1.code, onHandAfter: 3, reservedAfter: 3 };
    await expect(prisma.inventoryMovement.create({ data: { ...base, type: "PICK", qtyDelta: -1, reservedDelta: 0 } })).rejects.toBeTruthy(); // reserved must fall too
    await expect(prisma.inventoryMovement.create({ data: { ...base, type: "PICK", qtyDelta: 1, reservedDelta: 1 } })).rejects.toBeTruthy(); // must be negative
    await expect(prisma.inventoryMovement.create({ data: { ...base, type: "PICK", qtyDelta: -2, reservedDelta: -1 } })).rejects.toBeTruthy(); // amounts must match
    await expect(prisma.inventoryMovement.updateMany({ where: { id: m.id }, data: { qtyDelta: -9 } })).rejects.toBeTruthy();
    await expect(prisma.inventoryMovement.deleteMany({ where: { id: m.id } })).rejects.toBeTruthy();
  });

  it("a reservation line cannot be consumed beyond its quantity, and order-managed positions stay protected from layout deletion while picks are pending", async () => {
    const { ctx, order, B1 } = await setup();
    await allocateOrder(ctx, { orderId: order.id });
    const t = await taskAt(B1.code);
    await expect(prisma.reservationLine.update({ where: { id: t.reservationLineId }, data: { consumedQuantity: 6 } })).rejects.toBeTruthy();
    // pending pick => reserved > 0 => the Phase 3 position guard refuses to remove the position
    await expect(prisma.position.delete({ where: { id: B1.id } })).rejects.toMatchObject({ code: "P2003" });
  });
});

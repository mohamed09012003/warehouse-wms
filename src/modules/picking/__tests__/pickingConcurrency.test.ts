// Concurrency tests for the picking workflow: many simultaneous requests against the real test
// database must never over-pick, double-consume, deadlock, or leave stock/orders inconsistent.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPickingInvariants, makeOrder, makeProduct, prepareWave, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AppError, InsufficientStockError, InvalidStateError, TaskNotPickableError, PickQuantityError } from "@/lib/errors";
import { adjustStock, moveStock } from "@/modules/inventory";
import { getOrder } from "@/modules/orders";
import { addOrdersToWave, allocateOrder, cancelOrder, cancelWave, confirmPick, createWave, releaseWave, startWave } from "..";

beforeEach(resetDatabase);

const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;
const rejections = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
const pick = (t: { id: string; positionCode: string }, qty: number, extra: object = {}) =>
  ({ taskId: t.id, locationCode: t.positionCode, productCode: "SOLAR-A", quantity: qty, ...extra });

async function setup(stock = [5, 7], requested = 12) {
  const t = await tenantWithWarehouse("pc", { bays: 4, levels: 2 });
  const prod = await makeProduct(t.ctx, "SOLAR-A");
  const spots = [t.byCode("R01-L01-B01-P01"), t.byCode("R01-L01-B02-P01"), t.byCode("R01-L01-B03-P01")];
  for (const [i, q] of stock.entries()) await stockAt(t.ctx, prod.id, spots[i].id, q);
  const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: requested }]);
  return { ...t, prod, spots, order };
}
const tasksOf = () => prisma.pickTask.findMany({ orderBy: { positionCode: "asc" } });

describe("concurrent picks", () => {
  it("two simultaneous completions of the same task: exactly one succeeds, stock is consumed once", async () => {
    const { ctx, prod, spots, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const [t1] = await tasksOf(); // 5 units at B01
    const results = await Promise.allSettled([confirmPick(ctx, pick(t1, 5)), confirmPick(ctx, pick(t1, 5))]);
    expect(fulfilled(results)).toBe(1);
    const err = rejections(results)[0];
    expect(err instanceof TaskNotPickableError || err instanceof PickQuantityError).toBe(true);
    expect(await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: spots[0].id, productId: prod.id } })).toMatchObject({ onHand: 0, reserved: 0 });
    expect(await prisma.inventoryMovement.count({ where: { type: "PICK" } })).toBe(1);
    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: t1.id } }))).toMatchObject({ pickedQty: 5, status: "COMPLETED" });
    await assertPickingInvariants();
  });

  it("many 1-unit picks racing on a 5-unit task: exactly 5 succeed, never over-picked", async () => {
    const { ctx, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const [t1] = await tasksOf();
    const results = await Promise.allSettled(Array.from({ length: 14 }, () => confirmPick(ctx, pick(t1, 1))));
    expect(fulfilled(results)).toBe(5);
    for (const e of rejections(results)) expect(e instanceof TaskNotPickableError || e instanceof PickQuantityError).toBe(true);
    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: t1.id } })).pickedQty).toBe(5);
    await assertPickingInvariants();
  });

  it("concurrent attempts against the same reserved quantity (same line, same position) consume it exactly once", async () => {
    const { ctx, prod, spots, order } = await setup([6], 6);
    await prepareWave(ctx, [order.id]);
    const [t1] = await tasksOf();
    const results = await Promise.allSettled([confirmPick(ctx, pick(t1, 4)), confirmPick(ctx, pick(t1, 4)), confirmPick(ctx, pick(t1, 3)), confirmPick(ctx, pick(t1, 2))]);
    const done = (await prisma.pickTask.findUniqueOrThrow({ where: { id: t1.id } })).pickedQty;
    expect(done).toBeLessThanOrEqual(6);
    expect((await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: spots[0].id, productId: prod.id } })).onHand).toBe(6 - done);
    expect(fulfilled(results)).toBeGreaterThanOrEqual(1);
    await assertPickingInvariants();
  });

  it("a duplicate browser submission (same idempotency key, in parallel) consumes stock once", async () => {
    const { ctx, prod, spots, order } = await setup();
    await prepareWave(ctx, [order.id]);
    const [t1] = await tasksOf();
    const req = pick(t1, 2, { idempotencyKey: "dup-pick-000001" });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => confirmPick(ctx, req)));
    expect(fulfilled(results)).toBe(8); // every duplicate gets the same successful answer
    expect(results.filter((r) => r.status === "fulfilled" && !(r.value as { replayed: boolean }).replayed)).toHaveLength(1);
    expect(await prisma.inventoryMovement.count({ where: { type: "PICK" } })).toBe(1);
    expect((await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: spots[0].id, productId: prod.id } })).onHand).toBe(3);
    await assertPickingInvariants();
  });

  it("picks on different tasks of the same order line and wave in parallel all succeed with exact totals", async () => {
    const { ctx, order } = await setup([5, 7], 12);
    const waveId = await prepareWave(ctx, [order.id]);
    const tasks = await tasksOf();
    const ops = tasks.flatMap((t) => Array.from({ length: t.quantity }, () => confirmPick(ctx, pick(t, 1))));
    const results = await Promise.allSettled(ops);
    expect(fulfilled(results)).toBe(12);
    expect((await getOrder(ctx, order.id)).status).toBe("PICKED");
    expect((await prisma.pickingWave.findUniqueOrThrow({ where: { id: waveId } })).status).toBe("COMPLETED");
    expect(await prisma.orderLine.findFirstOrThrow()).toMatchObject({ requestedQty: 12, allocatedQty: 12, pickedQty: 12 });
    await assertPickingInvariants();
  });

  it("order-line over-picking is impossible even with many parallel confirmations across tasks", async () => {
    const { ctx, order } = await setup([5, 7], 8); // allocated 8: tasks 5 + 3
    await prepareWave(ctx, [order.id]);
    const tasks = await tasksOf();
    const ops = tasks.flatMap((t) => Array.from({ length: t.quantity + 3 }, () => confirmPick(ctx, pick(t, 1))));
    const results = await Promise.allSettled(ops);
    expect(fulfilled(results)).toBe(8);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    expect(await prisma.orderLine.findFirstOrThrow()).toMatchObject({ allocatedQty: 8, pickedQty: 8 });
    await assertPickingInvariants();
  });
});

describe("concurrent allocation", () => {
  it("two orders competing for the same stock never allocate more than is available", async () => {
    const { ctx, prod, order } = await setup([10], 8);
    const o2 = await makeOrder(ctx, [{ productId: prod.id, quantity: 8 }]);
    const results = await Promise.allSettled([allocateOrder(ctx, { orderId: order.id }), allocateOrder(ctx, { orderId: o2.id })]);
    expect(fulfilled(results)).toBe(2);
    const lines = await prisma.orderLine.findMany();
    expect(lines.reduce((n, l) => n + l.allocatedQty, 0)).toBe(10); // 8 + 2, exactly the stock
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(10);
    await assertPickingInvariants();
  });

  it("many orders allocating at once: total reserved never exceeds on-hand; losers fail cleanly", async () => {
    const { ctx, prod } = await setup([10], 1);
    const orders = await Promise.all(Array.from({ length: 12 }, () => makeOrder(ctx, [{ productId: prod.id, quantity: 2 }])));
    const results = await Promise.allSettled(orders.map((o) => allocateOrder(ctx, { orderId: o.id })));
    for (const e of rejections(results)) expect(e instanceof InsufficientStockError).toBe(true);
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(10);
    expect((await prisma.orderLine.aggregate({ _sum: { allocatedQty: true } }))._sum.allocatedQty).toBe(10);
    await assertPickingInvariants();
  });

  it("allocating the same order twice at once reserves its quantity exactly once", async () => {
    const { ctx, order } = await setup([20], 8);
    const results = await Promise.allSettled([allocateOrder(ctx, { orderId: order.id }), allocateOrder(ctx, { orderId: order.id }), allocateOrder(ctx, { orderId: order.id })]);
    expect(fulfilled(results)).toBe(1);
    for (const e of rejections(results)) expect(e instanceof InvalidStateError).toBe(true);
    expect((await getOrder(ctx, order.id)).lines[0].allocatedQty).toBe(8);
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(8);
    expect(await prisma.pickTask.count()).toBe(1);
    await assertPickingInvariants();
  });

  it("allocation racing with manual moves/adjustments of the same stock: invariants hold, no deadlock", async () => {
    const { ctx, prod, spots, order } = await setup([10, 10], 14);
    const ops: Promise<unknown>[] = [allocateOrder(ctx, { orderId: order.id })];
    for (let i = 0; i < 6; i++) {
      ops.push(moveStock(ctx, { productId: prod.id, fromPositionId: spots[0].id, toPositionId: spots[1].id, quantity: 1 }));
      ops.push(moveStock(ctx, { productId: prod.id, fromPositionId: spots[1].id, toPositionId: spots[0].id, quantity: 1 }));
      ops.push(adjustStock(ctx, { productId: prod.id, positionId: spots[0].id, delta: -1, reason: "race" }));
    }
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof InsufficientStockError).toBe(true);
    await assertPickingInvariants();
  });
});

describe("concurrent updates across order, wave and task", () => {
  it("picks racing with cancelling the order: no deadlock, nothing negative, consistent end state", async () => {
    const { ctx, order } = await setup([5, 7], 12);
    await prepareWave(ctx, [order.id]);
    const tasks = await tasksOf();
    const ops: Promise<unknown>[] = [];
    for (const t of tasks) for (let i = 0; i < 4; i++) ops.push(confirmPick(ctx, pick(t, 1)));
    ops.push(cancelOrder(ctx, { orderId: order.id }));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    const o = await getOrder(ctx, order.id);
    expect(["CANCELLED", "PICKED"]).toContain(o.status);
    const line = await prisma.orderLine.findFirstOrThrow();
    expect(line.pickedQty).toBeLessThanOrEqual(line.allocatedQty);
    expect(await prisma.reservation.count({ where: { status: "ACTIVE" } })).toBe(0);
    await assertPickingInvariants();
  });

  it("picks racing with cancelling the wave: no deadlock, reservations all closed, ledger consistent", async () => {
    const { ctx, order } = await setup([5, 7], 12);
    const waveId = await prepareWave(ctx, [order.id]);
    const tasks = await tasksOf();
    const ops: Promise<unknown>[] = [];
    for (const t of tasks) for (let i = 0; i < 4; i++) ops.push(confirmPick(ctx, pick(t, 1)));
    ops.push(cancelWave(ctx, { waveId }));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    expect(await prisma.reservation.count({ where: { status: "ACTIVE" } })).toBe(0);
    await assertPickingInvariants();
  });

  it("adding the same order to two waves at once puts its tasks into exactly one wave", async () => {
    const { ctx, order } = await setup([5, 7], 12);
    await allocateOrder(ctx, { orderId: order.id });
    const w1 = await createWave(ctx, {});
    const w2 = await createWave(ctx, {});
    const results = await Promise.allSettled([addOrdersToWave(ctx, { waveId: w1.id, orderIds: [order.id] }), addOrdersToWave(ctx, { waveId: w2.id, orderIds: [order.id] })]);
    expect(fulfilled(results)).toBe(1);
    const tasks = await prisma.pickTask.findMany();
    expect(new Set(tasks.map((t) => t.waveId)).size).toBe(1);
    expect(tasks.every((t) => t.waveId !== null)).toBe(true);
    await assertPickingInvariants();
  });

  it("releasing/starting a wave while picks arrive never lets a pick through before the wave is started", async () => {
    const { ctx, order } = await setup([5, 7], 12);
    await allocateOrder(ctx, { orderId: order.id });
    const wave = await createWave(ctx, {});
    await addOrdersToWave(ctx, { waveId: wave.id, orderIds: [order.id] });
    await releaseWave(ctx, { waveId: wave.id });
    const tasks = await tasksOf();
    const ops: Promise<unknown>[] = tasks.map((t) => confirmPick(ctx, pick(t, 1)));
    ops.push(startWave(ctx, { waveId: wave.id }));
    const results = await Promise.allSettled(ops);
    // every pick that succeeded did so after the wave was IN_PROGRESS
    const started = (await prisma.pickingWave.findUniqueOrThrow({ where: { id: wave.id } })).startedAt!;
    for (const m of await prisma.inventoryMovement.findMany({ where: { type: "PICK" } })) expect(m.createdAt.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    await assertPickingInvariants();
  });

  it("a randomized storm of picks, cancels, moves and allocations ends with every invariant intact", async () => {
    const { ctx, prod, spots } = await setup([8, 8, 8], 1);
    const orders = await Promise.all(Array.from({ length: 4 }, () => makeOrder(ctx, [{ productId: prod.id, quantity: 6 }])));
    await Promise.allSettled(orders.map((o) => allocateOrder(ctx, { orderId: o.id })));
    const waveId = await (async () => {
      const wave = await createWave(ctx, {});
      const ids = (await prisma.order.findMany({ where: { status: { in: ["ALLOCATED", "PARTIALLY_ALLOCATED"] } } })).map((o) => o.id);
      await addOrdersToWave(ctx, { waveId: wave.id, orderIds: ids });
      await releaseWave(ctx, { waveId: wave.id });
      await startWave(ctx, { waveId: wave.id });
      return wave.id;
    })();
    let seed = 5;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const tasks = await tasksOf();
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      switch (rnd(5)) {
        case 0: case 1: case 2: { const t = tasks[rnd(tasks.length)]; ops.push(confirmPick(ctx, pick(t, 1 + rnd(2)))); break; }
        case 3: ops.push(moveStock(ctx, { productId: prod.id, fromPositionId: spots[rnd(3)].id, toPositionId: spots[rnd(3)].id, quantity: 1 }).catch((e) => e)); break;
        default: ops.push(allocateOrder(ctx, { orderId: orders[rnd(orders.length)].id }));
      }
    }
    if (rnd(2)) ops.push(cancelOrder(ctx, { orderId: orders[rnd(orders.length)].id }));
    else ops.push(cancelWave(ctx, { waveId }));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true); // typed domain errors only: no deadlocks, no raw DB errors
    await assertPickingInvariants();
  });
});

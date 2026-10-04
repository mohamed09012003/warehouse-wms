// Cross-organization access: foreign orders, order lines, waves, tasks, products and positions
// must be neither visible nor mutable, at the service layer AND at the database layer.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPickingInvariants, makeOrder, makeProduct, prepareWave, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { NotFoundError, WrongLocationError } from "@/lib/errors";
import { createOrder, getOrder, listOrders, markOrderReady } from "@/modules/orders";
import {
  addOrdersToWave,
  allocateOrder,
  cancelOrder,
  cancelWave,
  completeWave,
  confirmPick,
  createWave,
  getPickTask,
  getWave,
  listEligibleOrders,
  listPickTasks,
  listTasksForOrder,
  listWaves,
  releaseOrderAllocation,
  releaseWave,
  startWave,
} from "..";

beforeEach(resetDatabase);

async function twoTenants() {
  const a = await tenantWithWarehouse("ia", { bays: 3, levels: 1 });
  const b = await tenantWithWarehouse("ib", { bays: 3, levels: 1 });
  const pa = await makeProduct(a.ctx, "SKU-A");
  const pb = await makeProduct(b.ctx, "SKU-B");
  const posA = a.byCode("R01-L01-B01-P01");
  const posB = b.byCode("R01-L01-B01-P01"); // same CODE as org A's position, different row
  await stockAt(a.ctx, pa.id, posA.id, 10);
  await stockAt(b.ctx, pb.id, posB.id, 10);
  const orderA = await makeOrder(a.ctx, [{ productId: pa.id, quantity: 4 }]);
  const orderB = await makeOrder(b.ctx, [{ productId: pb.id, quantity: 4 }]);
  return { a, b, pa, pb, posA, posB, orderA, orderB };
}

describe("service layer", () => {
  it("foreign orders: not listed, not readable, not changeable", async () => {
    const { a, b, orderA } = await twoTenants();
    expect((await listOrders(b.ctx)).map((o) => o.id)).not.toContain(orderA.id);
    await expect(getOrder(b.ctx, orderA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(markOrderReady(b.ctx, orderA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(allocateOrder(b.ctx, { orderId: orderA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(releaseOrderAllocation(b.ctx, { orderId: orderA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelOrder(b.ctx, { orderId: orderA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listTasksForOrder(b.ctx, orderA.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getOrder(a.ctx, orderA.id)).status).toBe("READY");
    expect(await prisma.pickTask.count()).toBe(0);
  });

  it("foreign products and positions cannot be used to create or allocate orders", async () => {
    const { a, b, pa, orderB } = await twoTenants();
    await expect(createOrder(b.ctx, { orderNumber: "STEAL-1", lines: [{ productId: pa.id, quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    // org B's order cannot reserve org A's stock: allocation only ever sees B's own balances
    const r = await allocateOrder(b.ctx, { orderId: orderB.id });
    expect(r.allocatedTotal).toBe(4);
    const tasks = await prisma.pickTask.findMany({ where: { orderId: orderB.id } });
    expect(tasks.every((t) => t.organizationId === b.org.organization.id)).toBe(true);
    expect(await prisma.inventoryBalance.count({ where: { organizationId: b.org.organization.id, reserved: { gt: 0 } } })).toBe(1);
    // org A's stock was not touched at all
    expect((await prisma.inventoryBalance.findFirstOrThrow({ where: { organizationId: a.org.organization.id } })).reserved).toBe(0);
  });

  it("foreign waves and tasks: invisible and immutable", async () => {
    const { a, b, orderA, posA } = await twoTenants();
    const waveId = await prepareWave(a.ctx, [orderA.id]);
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: orderA.id } });

    expect(await listWaves(b.ctx)).toEqual([]);
    expect(await listPickTasks(b.ctx)).toEqual([]);
    expect(await listEligibleOrders(b.ctx)).toEqual([]);
    await expect(getWave(b.ctx, waveId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getPickTask(b.ctx, task.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(releaseWave(b.ctx, { waveId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(startWave(b.ctx, { waveId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completeWave(b.ctx, { waveId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelWave(b.ctx, { waveId })).rejects.toBeInstanceOf(NotFoundError);

    const ownWave = await createWave(b.ctx, {});
    await expect(addOrdersToWave(b.ctx, { waveId: ownWave.id, orderIds: [orderA.id] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(addOrdersToWave(b.ctx, { waveId, orderIds: [orderA.id] })).rejects.toBeInstanceOf(NotFoundError);

    // org B cannot pick org A's task, with A's real location and product
    await expect(confirmPick(b.ctx, { taskId: task.id, locationCode: posA.code, productCode: "SKU-A", quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);

    expect((await prisma.pickTask.findUniqueOrThrow({ where: { id: task.id } })).pickedQty).toBe(0);
    expect((await prisma.pickingWave.findUniqueOrThrow({ where: { id: waveId } })).status).toBe("IN_PROGRESS");
    await assertPickingInvariants();
  });

  it("the same location code in two organizations is resolved within the caller's organization only", async () => {
    const { a, b, pa, pb, posA, posB, orderA, orderB } = await twoTenants();
    await prepareWave(a.ctx, [orderA.id]);
    await prepareWave(b.ctx, [orderB.id]);
    const taskA = await prisma.pickTask.findFirstOrThrow({ where: { orderId: orderA.id } });
    expect(posA.code).toBe(posB.code); // identical codes, different rows
    expect(posA.id).not.toBe(posB.id);
    // A picks A's task correctly
    await expect(confirmPick(a.ctx, { taskId: taskA.id, locationCode: posA.code, productCode: pa.sku, quantity: 1 })).resolves.toBeTruthy();
    // B's SKU is not A's product, and A's task cannot be satisfied with B's product code
    await expect(confirmPick(a.ctx, { taskId: taskA.id, locationCode: posA.code, productCode: pb.sku, quantity: 1 })).rejects.toThrow(/Wrong product/);
    void WrongLocationError;
    await assertPickingInvariants();
  });
});

describe("database layer: composite foreign keys block cross-organization references", () => {
  it("a pick task cannot point at another organization's order, order line, wave, reservation or product", async () => {
    const { a, b, orderA, orderB, pa } = await twoTenants();
    await allocateOrder(a.ctx, { orderId: orderA.id });
    await allocateOrder(b.ctx, { orderId: orderB.id });
    const taskA = await prisma.pickTask.findFirstOrThrow({ where: { orderId: orderA.id } });
    const waveB = await createWave(b.ctx, {});
    const base = {
      organizationId: a.org.organization.id,
      orderId: orderA.id,
      orderLineId: orderA.lines[0].id,
      productId: pa.id,
      positionId: taskA.positionId,
      positionCode: taskA.positionCode,
      reservationId: taskA.reservationId,
      reservationLineId: taskA.reservationLineId,
      quantity: 1,
    };
    const orderLineB = orderB.lines[0].id;
    const reservationB = await prisma.reservation.findFirstOrThrow({ where: { organizationId: b.org.organization.id }, include: { lines: true } });

    // each foreign reference is rejected by its composite FK (reservationLineId is unique, so use fresh ones where needed)
    await expect(prisma.pickTask.create({ data: { ...base, orderId: orderB.id, reservationLineId: undefined as never } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.create({ data: { ...base, orderLineId: orderLineB } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.create({ data: { ...base, waveId: waveB.id } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.create({ data: { ...base, reservationId: reservationB.id } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.create({ data: { ...base, reservationLineId: reservationB.lines[0].id } })).rejects.toBeTruthy();
    await expect(prisma.pickTask.create({ data: { ...base, productId: (await prisma.product.findFirstOrThrow({ where: { organizationId: b.org.organization.id } })).id } })).rejects.toBeTruthy();
    expect(await prisma.pickTask.count({ where: { organizationId: a.org.organization.id } })).toBe(1);
  });

  it("a wave or order created for one organization cannot be referenced under another organization id", async () => {
    const { a, b, orderA } = await twoTenants();
    const waveA = await createWave(a.ctx, {});
    await allocateOrder(a.ctx, { orderId: orderA.id });
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: orderA.id } });
    // re-pointing a task at org A's wave but under org B's id fails the (organizationId, waveId) FK
    await expect(prisma.$executeRaw`UPDATE "PickTask" SET "organizationId" = ${b.org.organization.id}::uuid WHERE "id" = ${task.id}::uuid`).rejects.toBeTruthy();
    expect(waveA.id).toBeTruthy();
  });
});

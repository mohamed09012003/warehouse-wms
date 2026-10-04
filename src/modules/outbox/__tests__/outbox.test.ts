// The outbox: exactly one event per successful business transition, written in the SAME transaction,
// never on rollback or idempotent replay, thin payloads, immutable rows.
import { beforeEach, describe, expect, it } from "vitest";
import { findSecretLookingKeys } from "@/lib/redact";
import { createOrder } from "@/modules/orders";
import { allocateOrder, cancelOrder, confirmPick } from "@/modules/picking";
import { addPackageItem, completePackage, completePacking, createPackage, startPacking } from "@/modules/packing";
import { withTransaction } from "@/server/db";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { makeOrder, makeProduct, pickOrder, prepareWave, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { recordEvent, OUTBOX_EVENT_TYPES } from "..";

beforeEach(resetDatabase);

const events = () => prisma.outboxEvent.findMany({ orderBy: { seq: "asc" } });
const types = async () => (await events()).map((e) => e.eventType);

async function setup(stock = 40) {
  const t = await tenantWithWarehouse("ob", { bays: 3, levels: 1 });
  const prod = await makeProduct(t.ctx, "SKU-A");
  await stockAt(t.ctx, prod.id, t.byCode("R01-L01-B01-P01").id, stock);
  return { ...t, prod };
}

describe("one event per successful transition", () => {
  it("publishes created -> allocated -> picked -> packed with the right payloads, once each", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 10 }], { orderNumber: "ORD-100" });
    expect(await types()).toEqual(["order.created"]);

    await pickOrder(ctx, order.id); // allocate + wave + picks
    expect(await types()).toEqual(["order.created", "order.allocated", "order.picked"]);

    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id, packageType: "Box", weightG: 2500, lengthMm: 400, widthMm: 300, heightMm: 200 });
    await addPackageItem(ctx, { packageId: p1.packageId!, productCode: "SKU-A", quantity: 6 });
    await completePackage(ctx, { packageId: p1.packageId! });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: p2.packageId!, productCode: "SKU-A", quantity: 4 });
    await completePackage(ctx, { packageId: p2.packageId! });
    expect(await types()).toEqual(["order.created", "order.allocated", "order.picked"]); // nothing yet: not packed
    await completePacking(ctx, { sessionId: s.session.id });
    expect(await types()).toEqual(["order.created", "order.allocated", "order.picked", "order.packed"]);

    const [created, allocated, picked, packed] = await events();
    const base = { orderId: order.id, orderNumber: "ORD-100", externalRef: null };
    expect(created.payload).toMatchObject({ ...base, status: "READY", lines: [{ sku: "SKU-A", requestedQty: 10, allocatedQty: 0, pickedQty: 0, packedQty: 0 }] });
    expect(allocated.payload).toMatchObject({ ...base, status: "ALLOCATED", allocationState: "FULL", allocatedNow: 10, requestedTotal: 10, allocatedTotal: 10 });
    expect(picked.payload).toMatchObject({ ...base, status: "PICKED", pickedTotal: 10 });
    expect(packed.payload).toMatchObject({
      ...base,
      status: "PACKED",
      packages: [
        { packageNumber: 1, packageType: "Box", weightG: 2500, lengthMm: 400, widthMm: 300, heightMm: 200, items: [{ sku: "SKU-A", quantity: 6 }] },
        { packageNumber: 2, packageType: null, weightG: null, items: [{ sku: "SKU-A", quantity: 4 }] },
      ],
    });
    for (const e of [created, allocated, picked, packed]) {
      expect(e.schemaVersion).toBe(1);
      expect(e.organizationId).toBe(ctx.organizationId);
      expect(e.fannedOutAt).toBeNull();
    }
  });

  it("order.picked is published only by the pick that completes the order", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 10 }]);
    await pickOrder(ctx, order.id, 4);
    expect(await types()).toEqual(["order.created", "order.allocated"]);
    const tasks = await prisma.pickTask.findMany({ where: { orderId: order.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, include: { product: true } });
    for (const t of tasks) await confirmPick(ctx, { taskId: t.id, locationCode: t.positionCode, productCode: t.product.sku, quantity: t.quantity - t.pickedQty });
    expect((await types()).filter((t) => t === "order.picked")).toHaveLength(1);
  });

  it("order.packed is published only when every requested unit is picked AND packed (not for a partial session)", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 10 }]);
    await pickOrder(ctx, order.id, 6);
    const s1 = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s1.session.id });
    await addPackageItem(ctx, { packageId: p1.packageId!, productCode: "SKU-A", quantity: 6 });
    await completePackage(ctx, { packageId: p1.packageId! });
    await completePacking(ctx, { sessionId: s1.session.id });
    expect((await types()).includes("order.packed")).toBe(false);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PICKING");

    // pick the remaining 4 units (their task is already in the started wave): the order is now fully picked
    const rest = await prisma.pickTask.findMany({ where: { orderId: order.id, status: { in: ["PENDING", "IN_PROGRESS"] } }, include: { product: true } });
    for (const t of rest) await confirmPick(ctx, { taskId: t.id, locationCode: t.positionCode, productCode: t.product.sku, quantity: t.quantity - t.pickedQty });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PICKED");
    expect((await types()).filter((t) => t === "order.picked")).toHaveLength(1);

    // the second session packs the remainder; only now is the order PACKED, and the event lists the packages of BOTH sessions
    const s2 = await startPacking(ctx, { orderId: order.id });
    const p2 = await createPackage(ctx, { sessionId: s2.session.id });
    await addPackageItem(ctx, { packageId: p2.packageId!, productCode: "SKU-A", quantity: 4 });
    await completePackage(ctx, { packageId: p2.packageId! });
    await completePacking(ctx, { sessionId: s2.session.id });
    const packed = (await events()).filter((e) => e.eventType === "order.packed");
    expect(packed).toHaveLength(1);
    expect((packed[0].payload as { packages: { packageNumber: number; items: { quantity: number }[] }[] }).packages.map((p) => [p.packageNumber, p.items[0].quantity])).toEqual([[1, 6], [2, 4]]);
  });

  it("cancel publishes order.cancelled with the previous status; release (not cancel) publishes nothing", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }], { orderNumber: "ORD-C" });
    await allocateOrder(ctx, { orderId: order.id });
    await cancelOrder(ctx, { orderId: order.id });
    const all = await events();
    expect(all.map((e) => e.eventType)).toEqual(["order.created", "order.allocated", "order.cancelled"]);
    expect(all[2].payload).toMatchObject({ orderNumber: "ORD-C", previousStatus: "ALLOCATED", tasksCancelled: 1 });
  });

  it("an order created with an external reference carries it in every event", async () => {
    const { ctx, prod } = await setup();
    const order = await createOrder(ctx, { orderNumber: "EXT-1", externalRef: "shop-42", ready: true, lines: [{ productId: prod.id, quantity: 2 }] });
    await allocateOrder(ctx, { orderId: order.id });
    await cancelOrder(ctx, { orderId: order.id });
    for (const e of await events()) expect(e.payload).toMatchObject({ externalRef: "shop-42", orderNumber: "EXT-1" });
  });
});

describe("no event without a committed transition", () => {
  it("failed operations publish nothing", async () => {
    const { ctx, prod } = await setup(5);
    const ok = await makeOrder(ctx, [{ productId: prod.id, quantity: 5 }]);
    const tooBig = await makeOrder(ctx, [{ productId: prod.id, quantity: 500 }]);
    await allocateOrder(ctx, { orderId: ok.id });
    const before = await types();
    await expect(allocateOrder(ctx, { orderId: tooBig.id })).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" }); // nothing allocatable
    await expect(allocateOrder(ctx, { orderId: ok.id })).rejects.toMatchObject({ code: "INVALID_STATE" }); // already fully allocated
    await expect(createOrder(ctx, { orderNumber: "BAD-1", lines: [{ productId: "00000000-0000-4000-8000-000000000000", quantity: 1 }] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createOrder(ctx, { orderNumber: "ORD-1", lines: [] })).rejects.toBeTruthy();
    expect(await types()).toEqual(before);
  });

  it("a pick refused for the wrong location or product writes no order.picked event", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 3 }]);
    await prepareWave(ctx, [order.id]);
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: order.id }, include: { product: true } });
    await expect(confirmPick(ctx, { taskId: task.id, locationCode: "R01-L01-B02-P01", productCode: "SKU-A", quantity: 3 })).rejects.toMatchObject({ code: "WRONG_LOCATION" });
    await expect(confirmPick(ctx, { taskId: task.id, locationCode: task.positionCode, productCode: "NOPE", quantity: 3 })).rejects.toBeTruthy();
    await expect(confirmPick(ctx, { taskId: task.id, locationCode: task.positionCode, productCode: "SKU-A", quantity: 99 })).rejects.toMatchObject({ code: "PICK_QUANTITY_EXCEEDED" });
    expect((await types()).includes("order.picked")).toBe(false);
  });

  it("the event is part of the caller's transaction: a rollback removes the order AND its event", async () => {
    const { ctx, prod } = await setup();
    await expect(
      withTransaction(async (tx) => {
        await createOrder(ctx, { orderNumber: "ROLLED-BACK", ready: true, lines: [{ productId: prod.id, quantity: 1 }] }, { tx });
        expect(await tx.outboxEvent.count()).toBe(1); // visible inside the transaction
        throw new Error("abort after the order was created");
      }),
    ).rejects.toThrow("abort after");
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);

    await withTransaction(async (tx) => {
      await createOrder(ctx, { orderNumber: "COMMITTED", ready: true, lines: [{ productId: prod.id, quantity: 1 }] }, { tx });
    });
    expect(await types()).toEqual(["order.created"]);
  });

  it("an idempotent replay of an allocation publishes nothing more", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }]);
    const a = await allocateOrder(ctx, { orderId: order.id, idempotencyKey: "alloc-key-0001" });
    const again = await allocateOrder(ctx, { orderId: order.id, idempotencyKey: "alloc-key-0001" });
    expect([a.replayed, again.replayed]).toEqual([false, true]);
    expect((await types()).filter((t) => t === "order.allocated")).toHaveLength(1);
  });

  it("idempotent pick confirmation and packing completion publish their event once", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }]);
    await prepareWave(ctx, [order.id]);
    const task = await prisma.pickTask.findFirstOrThrow({ where: { orderId: order.id }, include: { product: true } });
    const pick = { taskId: task.id, locationCode: task.positionCode, productCode: "SKU-A", quantity: 4, idempotencyKey: "pick-key-00001" };
    expect((await confirmPick(ctx, pick)).replayed).toBe(false);
    expect((await confirmPick(ctx, pick)).replayed).toBe(true);
    expect((await types()).filter((t) => t === "order.picked")).toHaveLength(1);

    const s = await startPacking(ctx, { orderId: order.id });
    const pkg = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: pkg.packageId!, productCode: "SKU-A", quantity: 4 });
    await completePackage(ctx, { packageId: pkg.packageId! });
    expect((await completePacking(ctx, { sessionId: s.session.id, idempotencyKey: "pack-key-00001" })).replayed).toBe(false);
    expect((await completePacking(ctx, { sessionId: s.session.id, idempotencyKey: "pack-key-00001" })).replayed).toBe(true);
    await expect(completePacking(ctx, { sessionId: s.session.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await types()).filter((t) => t === "order.packed")).toHaveLength(1);
  });

  it("cancelling twice (with and without a key) publishes order.cancelled once", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 4 }]);
    await allocateOrder(ctx, { orderId: order.id });
    await cancelOrder(ctx, { orderId: order.id, idempotencyKey: "cancel-key-0001" });
    expect((await cancelOrder(ctx, { orderId: order.id, idempotencyKey: "cancel-key-0001" })).replayed).toBe(true);
    await expect(cancelOrder(ctx, { orderId: order.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await types()).filter((t) => t === "order.cancelled")).toHaveLength(1);
  });
});

describe("the outbox table", () => {
  it("events are thin: identifiers, quantities and package data only, no secret-looking field, small", async () => {
    const { ctx, prod } = await setup();
    const order = await makeOrder(ctx, [{ productId: prod.id, quantity: 2 }]);
    await pickOrder(ctx, order.id);
    const s = await startPacking(ctx, { orderId: order.id });
    const pkg = await createPackage(ctx, { sessionId: s.session.id, weightG: 1000 });
    await addPackageItem(ctx, { packageId: pkg.packageId!, productCode: "SKU-A", quantity: 2 });
    await completePackage(ctx, { packageId: pkg.packageId! });
    await completePacking(ctx, { sessionId: s.session.id });
    for (const e of await events()) {
      expect(findSecretLookingKeys(e.payload)).toEqual([]);
      expect(JSON.stringify(e.payload).length).toBeLessThan(4000);
      expect(OUTBOX_EVENT_TYPES as readonly string[]).toContain(e.eventType);
    }
  });

  it("rows are immutable except the one-time fan-out marker, and sequence numbers increase", async () => {
    const { ctx, prod } = await setup();
    await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    const [a, b] = await events();
    expect(b.seq > a.seq).toBe(true);
    await expect(prisma.outboxEvent.update({ where: { id: a.id }, data: { eventType: "order.packed" } })).rejects.toBeTruthy();
    await expect(prisma.outboxEvent.update({ where: { id: a.id }, data: { payload: { tampered: true } } })).rejects.toBeTruthy();
    await expect(prisma.outboxEvent.update({ where: { id: a.id }, data: { occurredAt: new Date(0) } })).rejects.toBeTruthy();
    await prisma.outboxEvent.update({ where: { id: a.id }, data: { fannedOutAt: new Date() } });
    await expect(prisma.outboxEvent.update({ where: { id: a.id }, data: { fannedOutAt: new Date(0) } })).rejects.toBeTruthy();
    await expect(prisma.outboxEvent.update({ where: { id: a.id }, data: { fannedOutAt: null } })).rejects.toBeTruthy();
  });

  it("recordEvent refuses unknown types, secret-looking payloads and oversized payloads", async () => {
    const { ctx } = await setup();
    const rec = (event: Parameters<typeof recordEvent>[2]) => withTransaction((tx) => recordEvent(tx, ctx, event));
    await expect(rec({ type: "inventory.changed" as never, payload: {} })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(rec({ type: "order.created", payload: { apiKey: "x" } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(rec({ type: "order.created", payload: { nested: { password: "x" } } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(rec({ type: "order.created", payload: { big: "x".repeat(70_000) } })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await prisma.outboxEvent.count()).toBe(0);
    const id = await rec({ type: "order.created", payload: { ok: true } });
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id } })).organizationId).toBe(ctx.organizationId);
  });

  it("the database enforces the event-type shape and payload size", async () => {
    const { ctx } = await setup();
    const base = { organizationId: ctx.organizationId, payload: {} };
    await expect(prisma.outboxEvent.create({ data: { ...base, eventType: "Not A Type" } })).rejects.toBeTruthy();
    await expect(prisma.outboxEvent.create({ data: { ...base, eventType: "order.created", schemaVersion: 0 } })).rejects.toBeTruthy();
    await expect(prisma.outboxEvent.create({ data: { ...base, eventType: "order.created", payload: { big: "x".repeat(300_000) } } })).rejects.toBeTruthy();
  });

  it("events exist even when no integration is configured, and each tenant only has its own", async () => {
    const a = await setup();
    const b = await tenantWithWarehouse("ob2", { bays: 1, levels: 1 });
    const pa = await makeProduct(b.ctx, "SKU-B");
    await makeOrder(a.ctx, [{ productId: a.prod.id, quantity: 1 }]);
    await makeOrder(b.ctx, [{ productId: pa.id, quantity: 1 }]);
    expect(await prisma.integration.count()).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { organizationId: a.ctx.organizationId } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { organizationId: b.ctx.organizationId } })).toBe(1);
  });
});

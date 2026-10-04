// Concurrency tests for packing. Packed quantity must never exceed picked quantity, and every
// shared record (session, package, order) must end in exactly one consistent state.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPackingInvariants, assertPickingInvariants, inventorySnapshot, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AppError, InvalidStateError, PackQuantityError } from "@/lib/errors";
import { getOrder } from "@/modules/orders";
import { addPackageItem, cancelPacking, completePackage, completePacking, createPackage, getPackingSession, removePackageItem, setPackageItemQuantity, startPacking } from "..";

beforeEach(resetDatabase);

const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;
const rejections = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);

async function setup(picked = 10) {
  const t = await tenantWithWarehouse("pc", { bays: 3, levels: 1 });
  const prod = await makeProduct(t.ctx, "SKU-A");
  await stockAt(t.ctx, prod.id, t.byCode("R01-L01-B01-P01").id, 50);
  const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: picked }]);
  await pickOrder(t.ctx, order.id);
  return { ...t, prod, order };
}
const add = (ctx: Parameters<typeof startPacking>[0], packageId: string, quantity: number, extra: object = {}) =>
  addPackageItem(ctx, { packageId, productCode: "SKU-A", quantity, ...extra });

describe("concurrent starts", () => {
  it("two (and many) simultaneous requests to start packing create exactly one open session", async () => {
    const { ctx, order } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => startPacking(ctx, { orderId: order.id })));
    expect(fulfilled(results)).toBe(1);
    for (const e of rejections(results)) expect(e instanceof InvalidStateError).toBe(true);
    expect(await prisma.packingSession.count()).toBe(1);
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    await assertPackingInvariants();
  });

  it("the same Idempotency-Key sent in parallel starts packing once and every caller gets the same session", async () => {
    const { ctx, order } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => startPacking(ctx, { orderId: order.id, idempotencyKey: "start-key-0001" })));
    expect(fulfilled(results)).toBe(6);
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof startPacking>>>).value.session.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === "fulfilled" && !(r.value as { replayed: boolean }).replayed)).toHaveLength(1);
    expect(await prisma.packingSession.count()).toBe(1);
  });
});

describe("concurrent additions", () => {
  it("many parallel additions against the remaining quantity: packed never exceeds picked, successes sum exactly to picked", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const packages = await Promise.all(Array.from({ length: 4 }, () => createPackage(ctx, { sessionId: s.session.id })));
    const ids = packages.map((p) => p.packageId!);
    const ops = Array.from({ length: 30 }, (_, i) => add(ctx, ids[i % 4], 1 + (i % 3)));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof PackQuantityError || e instanceof AppError).toBe(true);
    const line = await prisma.orderLine.findFirstOrThrow();
    expect(line.packedQty).toBeLessThanOrEqual(line.pickedQty);
    const inPackages = (await prisma.packageItem.aggregate({ _sum: { quantity: true } }))._sum.quantity ?? 0;
    expect(inPackages).toBe(line.packedQty);
    expect(line.packedQty).toBe(10); // the demand (1+2+3 repeated) far exceeds 10, so the whole picked quantity gets packed
    await assertPackingInvariants();
  });

  it("two requests fighting for the same last units: exactly one wins", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    await add(ctx, p1.packageId!, 6);
    const results = await Promise.allSettled([add(ctx, p1.packageId!, 4), add(ctx, p2.packageId!, 4), add(ctx, p2.packageId!, 4)]);
    expect(fulfilled(results)).toBe(1); // only 4 units remained
    expect((await prisma.orderLine.findFirstOrThrow()).packedQty).toBe(10);
    await assertPackingInvariants();
  });

  it("duplicate submissions (same Idempotency-Key, in parallel) add the quantity once", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => add(ctx, p.packageId!, 3, { idempotencyKey: "add-key-00001" })));
    expect(fulfilled(results)).toBe(8);
    expect(results.filter((r) => r.status === "fulfilled" && !(r.value as { replayed: boolean }).replayed)).toHaveLength(1);
    expect((await prisma.packageItem.findFirstOrThrow()).quantity).toBe(3);
    expect((await prisma.orderLine.findFirstOrThrow()).packedQty).toBe(3);
    await assertPackingInvariants();
  });

  it("a retried request with the same key returns the original outcome; the same key with a different request is a conflict", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    const first = await add(ctx, p.packageId!, 2, { idempotencyKey: "retry-key-0001" });
    const again = await add(ctx, p.packageId!, 2, { idempotencyKey: "retry-key-0001" });
    expect([first.replayed, again.replayed]).toEqual([false, true]);
    expect(again.session.packages[0].totalQuantity).toBe(2);
    await expect(add(ctx, p.packageId!, 5, { idempotencyKey: "retry-key-0001" })).rejects.toThrow(/idempotency key/i);
    expect((await prisma.orderLine.findFirstOrThrow()).packedQty).toBe(2);
  });

  it("a failed request does not burn its idempotency key", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await expect(add(ctx, p.packageId!, 11, { idempotencyKey: "burn-key-00001" })).rejects.toBeInstanceOf(PackQuantityError);
    expect(await prisma.idempotencyRecord.count()).toBe(0); // rolled back with the work
    await expect(add(ctx, p.packageId!, 11, { idempotencyKey: "burn-key-00001" })).rejects.toBeInstanceOf(PackQuantityError);
    // the key is still free, so it can be used for a corrected request, which is then applied once
    const ok = await add(ctx, p.packageId!, 4, { idempotencyKey: "burn-key-00001" });
    expect(ok.replayed).toBe(false);
    expect((await add(ctx, p.packageId!, 4, { idempotencyKey: "burn-key-00001" })).replayed).toBe(true);
    expect((await prisma.orderLine.findFirstOrThrow()).packedQty).toBe(4);
  });
});

describe("concurrent completion", () => {
  it("two simultaneous completions of the same package: exactly one succeeds", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await add(ctx, p.packageId!, 10);
    const results = await Promise.allSettled([completePackage(ctx, { packageId: p.packageId }), completePackage(ctx, { packageId: p.packageId }), completePackage(ctx, { packageId: p.packageId })]);
    expect(fulfilled(results)).toBe(1);
    for (const e of rejections(results)) expect(e instanceof InvalidStateError).toBe(true);
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } })).status).toBe("COMPLETED");
    expect(await prisma.packingEvent.count({ where: { type: "PACKAGE_COMPLETED" } })).toBe(1);
  });

  it("two simultaneous completions of the same packing session: exactly one succeeds and the order is PACKED once", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await add(ctx, p.packageId!, 10);
    await completePackage(ctx, { packageId: p.packageId });
    const results = await Promise.allSettled([completePacking(ctx, { sessionId: s.session.id }), completePacking(ctx, { sessionId: s.session.id }), completePacking(ctx, { sessionId: s.session.id })]);
    expect(fulfilled(results)).toBe(1);
    for (const e of rejections(results)) expect(e instanceof InvalidStateError).toBe(true);
    expect((await getOrder(ctx, order.id)).status).toBe("PACKED");
    expect(await prisma.packingEvent.count({ where: { type: "SESSION_COMPLETED" } })).toBe(1);
    await assertPackingInvariants();
  });

  it("completing the session while items are still being added: either the add or the completion wins, never an inconsistent state", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id });
    await add(ctx, p1.packageId!, 6);
    await completePackage(ctx, { packageId: p1.packageId });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    const results = await Promise.allSettled([add(ctx, p2.packageId!, 4), completePacking(ctx, { sessionId: s.session.id }), completePackage(ctx, { packageId: p2.packageId })]);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    const session = await getPackingSession(ctx, s.session.id);
    // whatever interleaving happened, the end state is internally consistent
    if (session.status === "COMPLETED") {
      expect(session.packedTotal).toBe(session.pickedTotal);
      expect(session.packages.every((p) => p.status === "COMPLETED" || p.status === "CANCELLED" || p.totalQuantity === 0)).toBe(true);
    }
    await assertPackingInvariants();
  });

  it("cancelling the session racing with additions and completions ends consistent, with no deadlock", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const packages = await Promise.all(Array.from({ length: 3 }, () => createPackage(ctx, { sessionId: s.session.id })));
    const ops: Promise<unknown>[] = [];
    for (const p of packages) {
      ops.push(add(ctx, p.packageId!, 2), add(ctx, p.packageId!, 1), completePackage(ctx, { packageId: p.packageId }));
    }
    ops.push(cancelPacking(ctx, { sessionId: s.session.id }));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true); // typed domain errors only
    await assertPackingInvariants();
  });
});

describe("concurrent corrections", () => {
  it("parallel quantity changes and removals on open packages keep packed == contents and packed <= picked", async () => {
    const { ctx, order } = await setup(10);
    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    const a1 = await add(ctx, p1.packageId!, 4);
    const a2 = await add(ctx, p2.packageId!, 4);
    const i1 = a1.session.packages[0].items[0].id;
    const i2 = a2.session.packages[1].items[0].id;
    const ops: Promise<unknown>[] = [];
    for (let q = 1; q <= 9; q++) {
      ops.push(setPackageItemQuantity(ctx, { itemId: i1, quantity: q }), setPackageItemQuantity(ctx, { itemId: i2, quantity: 10 - q }));
    }
    ops.push(removePackageItem(ctx, { itemId: i1 }), add(ctx, p1.packageId!, 3));
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    await assertPackingInvariants();
  });
});

describe("inventory safety under concurrency", () => {
  it("a storm of packing operations never changes inventory and never packs more than picked", async () => {
    const { ctx, order } = await setup(12);
    const before = await inventorySnapshot();
    const s = await startPacking(ctx, { orderId: order.id });
    const packages = await Promise.all(Array.from({ length: 3 }, () => createPackage(ctx, { sessionId: s.session.id })));
    let seed = 3;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i++) {
      const p = packages[rnd(3)];
      switch (rnd(4)) {
        case 0: case 1: ops.push(add(ctx, p.packageId!, 1 + rnd(4))); break;
        case 2: ops.push(completePackage(ctx, { packageId: p.packageId })); break;
        default: ops.push(completePacking(ctx, { sessionId: s.session.id }));
      }
    }
    const results = await Promise.allSettled(ops);
    for (const e of rejections(results)) expect(e instanceof AppError).toBe(true);
    expect(await inventorySnapshot()).toBe(before);
    await assertPackingInvariants();
    await assertPickingInvariants();
  });
});

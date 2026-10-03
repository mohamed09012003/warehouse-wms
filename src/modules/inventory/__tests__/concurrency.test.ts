// Concurrency tests: many simultaneous operations against the real test database must never
// produce an invalid balance, a lost update, or an unaudited change.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertLedgerMatchesBalances, makeProduct, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { InsufficientStockError } from "@/lib/errors";
import { adjustStock, createReservation, moveStock, receiveStock, releaseReservation } from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("c", { bays: 3, levels: 2 });
  const product = await makeProduct(t.ctx);
  return { ...t, product, A: t.byCode("R01-L01-B01-P01"), B: t.byCode("R01-L01-B02-P01") };
}
const balance = (positionId: string, productId: string) => prisma.inventoryBalance.findFirst({ where: { positionId, productId } });
const fulfilled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;
const insufficient = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "rejected" && r.reason instanceof InsufficientStockError).length;

describe("concurrent inventory operations", () => {
  it("20 simultaneous reservations for 5 units: exactly 5 succeed, available never goes negative", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 1 }] })),
    );
    expect(fulfilled(results)).toBe(5);
    expect(insufficient(results)).toBe(15);
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 5, reserved: 5 });
    expect(await prisma.reservation.count()).toBe(5);
    await assertLedgerMatchesBalances();
  });

  it("20 simultaneous moves of 1 unit out of a 10-unit position: exactly 10 succeed, nothing is lost or duplicated", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 10 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 1 })),
    );
    expect(fulfilled(results)).toBe(10);
    expect(insufficient(results)).toBe(10);
    expect((await balance(A.id, product.id))?.onHand).toBe(0);
    expect((await balance(B.id, product.id))?.onHand).toBe(10);
    await assertLedgerMatchesBalances();
  });

  it("opposite-direction transfers running together neither deadlock nor lose stock", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 50 });
    await receiveStock(ctx, { productId: product.id, positionId: B.id, quantity: 50 });
    const ops = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0
        ? moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 1 + (i % 3) })
        : moveStock(ctx, { productId: product.id, fromPositionId: B.id, toPositionId: A.id, quantity: 1 + (i % 3) }),
    );
    const results = await Promise.allSettled(ops);
    expect(fulfilled(results)).toBe(30);
    const a = (await balance(A.id, product.id))!.onHand;
    const b = (await balance(B.id, product.id))!.onHand;
    expect(a + b).toBe(100);
    await assertLedgerMatchesBalances();
  });

  it("concurrent first receipts into a new position create one balance row with the exact total", async () => {
    const { ctx, product, A } = await setup();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 3 })));
    expect(fulfilled(results)).toBe(12);
    expect(await prisma.inventoryBalance.count()).toBe(1);
    expect((await balance(A.id, product.id))?.onHand).toBe(36);
    await assertLedgerMatchesBalances();
  });

  it("reservations, adjustments, moves and releases racing on one balance keep every invariant", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 20 });
    const seed = await Promise.all(Array.from({ length: 4 }, () => createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 2 }] })));

    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) ops.push(createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 2 }] }));
    for (let i = 0; i < 8; i++) ops.push(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -2, reason: "race" }));
    for (let i = 0; i < 8; i++) ops.push(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 2 }));
    for (const s of seed.slice(0, 3)) ops.push(releaseReservation(ctx, { reservationId: s.reservationId }));
    for (let i = 0; i < 4; i++) ops.push(receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 1 }));

    const results = await Promise.allSettled(ops);
    // Only InsufficientStock is an acceptable failure; anything else (deadlock, constraint, ...) is a bug.
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(InsufficientStockError);
    }
    const rows = await prisma.inventoryBalance.findMany();
    for (const b of rows) {
      expect(b.onHand).toBeGreaterThanOrEqual(0);
      expect(b.reserved).toBeGreaterThanOrEqual(0);
      expect(b.reserved).toBeLessThanOrEqual(b.onHand);
    }
    // Active reservation lines add up exactly to the reserved total
    const activeLines = await prisma.reservationLine.findMany({ where: { reservation: { status: "ACTIVE" } } });
    const reservedTotal = rows.reduce((n, b) => n + b.reserved, 0);
    expect(activeLines.reduce((n, l) => n + l.quantity, 0)).toBe(reservedTotal);
    await assertLedgerMatchesBalances();
  });

  it("a repeated randomized storm never leaves an unaudited or invalid balance", async () => {
    const { ctx, product, A, B } = await setup();
    const C = (await prisma.position.findFirstOrThrow({ where: { code: "R01-L02-B01-P01" } }));
    const spots = [A, B, C];
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 30 });
    let seedNum = 7;
    const rnd = (n: number) => ((seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff) % n);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const from = spots[rnd(3)];
      const to = spots[rnd(3)];
      const q = 1 + rnd(4);
      switch (rnd(4)) {
        case 0: ops.push(receiveStock(ctx, { productId: product.id, positionId: from.id, quantity: q })); break;
        case 1: if (from.id !== to.id) ops.push(moveStock(ctx, { productId: product.id, fromPositionId: from.id, toPositionId: to.id, quantity: q })); break;
        case 2: ops.push(adjustStock(ctx, { productId: product.id, positionId: from.id, delta: -q, reason: "storm" })); break;
        default: ops.push(createReservation(ctx, { lines: [{ productId: product.id, positionId: from.id, quantity: q }] }));
      }
    }
    const results = await Promise.allSettled(ops);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(InsufficientStockError);
    await assertLedgerMatchesBalances();
  });
});

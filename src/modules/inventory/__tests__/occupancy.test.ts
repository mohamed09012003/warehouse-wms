// Business rule: a Position holds stock of ONE product at a time (the same product may grow freely).
// Enforced in the service (clear message) and by a partial unique index (the concurrency backstop).
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertLedgerMatchesBalances, makeProduct, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { InsufficientStockError, NotFoundError, PositionOccupiedError, normalizeError } from "@/lib/errors";
import { adjustStock, createReservation, listStock, moveStock, receiveStock } from "..";
import { inventoryRepo } from "../repo/inventoryRepo";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("o", { bays: 4, levels: 2 });
  const aiko = await makeProduct(t.ctx, "AIKO-SOLAR");
  const ja = await makeProduct(t.ctx, "JA-SOLAR");
  return {
    ...t,
    aiko,
    ja,
    P01: t.byCode("R01-L01-B01-P01"),
    P02: t.byCode("R01-L01-B02-P01"),
    P03: t.byCode("R01-L01-B03-P01"),
  };
}
const stockAt = (positionId: string) => prisma.inventoryBalance.findMany({ where: { positionId, onHand: { gt: 0 } } });
const balance = (positionId: string, productId: string) => prisma.inventoryBalance.findFirst({ where: { positionId, productId } });

describe("receiving", () => {
  it("1+2: a product can be received into an empty position and topped up; quantities combine", async () => {
    const { ctx, aiko, P01 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(10);
    expect(await stockAt(P01.id)).toHaveLength(1);
  });

  it("3: a different product is rejected while the position holds stock, with a clear message; nothing is written", async () => {
    const { ctx, aiko, ja, P01 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    const movementsBefore = await prisma.inventoryMovement.count();

    const err = await receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(PositionOccupiedError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("POSITION_OCCUPIED");
    expect(err.message).toContain("AIKO-SOLAR");
    expect(err.message).toContain(P01.code);

    expect(await balance(P01.id, ja.id)).toBeNull();
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(5);
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await prisma.inventoryOperation.count()).toBe(movementsBefore); // the failed attempt left no operation header either
  });

  it("the other product simply uses another position", async () => {
    const { ctx, aiko, ja, P01, P02 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await receiveStock(ctx, { productId: ja.id, positionId: P02.id, quantity: 5 });
    const rows = await listStock(ctx);
    expect(rows.map((r) => [r.sku, r.positionCode, r.onHand])).toEqual([
      ["AIKO-SOLAR", P01.code, 5],
      ["JA-SOLAR", P02.code, 5],
    ]);
  });
});

describe("moving", () => {
  it("4+5: a product can move into an empty position or into a position already holding it", async () => {
    const { ctx, aiko, P01, P02, P03 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P02.id, quantity: 6 });
    await receiveStock(ctx, { productId: aiko.id, positionId: P03.id, quantity: 4 });
    await moveStock(ctx, { productId: aiko.id, fromPositionId: P02.id, toPositionId: P01.id, quantity: 2 }); // empty destination
    await moveStock(ctx, { productId: aiko.id, fromPositionId: P03.id, toPositionId: P01.id, quantity: 3 }); // same product already there
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(5);
    expect((await balance(P02.id, aiko.id))?.onHand).toBe(4);
    expect((await balance(P03.id, aiko.id))?.onHand).toBe(1);
    await assertLedgerMatchesBalances();
  });

  it("6: moving a different product into an occupied position is rejected and the source is untouched", async () => {
    const { ctx, aiko, ja, P01, P02 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await receiveStock(ctx, { productId: ja.id, positionId: P02.id, quantity: 7 });

    await expect(moveStock(ctx, { productId: ja.id, fromPositionId: P02.id, toPositionId: P01.id, quantity: 3 })).rejects.toBeInstanceOf(PositionOccupiedError);
    expect((await balance(P02.id, ja.id))?.onHand).toBe(7);
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(5);
    expect(await balance(P01.id, ja.id)).toBeNull();
    await assertLedgerMatchesBalances();
  });
});

describe("adjusting", () => {
  it("an increase for a different product is rejected on an occupied position; the same product is fine", async () => {
    const { ctx, aiko, ja, P01 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await expect(adjustStock(ctx, { productId: ja.id, positionId: P01.id, delta: 2, reason: "count" })).rejects.toBeInstanceOf(PositionOccupiedError);
    await expect(adjustStock(ctx, { productId: aiko.id, positionId: P01.id, delta: 2, reason: "count" })).resolves.toBeTruthy();
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(7);
  });
});

describe("emptying a position frees it", () => {
  it("7+8: once the stock reaches zero (adjust or move), another product can take the position", async () => {
    const { ctx, aiko, ja, P01, P02 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await expect(receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 1 })).rejects.toBeInstanceOf(PositionOccupiedError);

    await adjustStock(ctx, { productId: aiko.id, positionId: P01.id, delta: -3, reason: "shipped" });
    await expect(receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 1 })).rejects.toBeInstanceOf(PositionOccupiedError); // 2 left
    await moveStock(ctx, { productId: aiko.id, fromPositionId: P01.id, toPositionId: P02.id, quantity: 2 }); // now 0

    expect(await listStock(ctx, { positionId: P01.id })).toEqual([]); // P01 is empty
    await expect(receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 4 })).resolves.toBeTruthy();
    expect((await balance(P01.id, ja.id))?.onHand).toBe(4);

    // the previous product has no lasting claim: its zero row is ignored, and it is now the one locked out
    expect((await balance(P01.id, aiko.id))?.onHand).toBe(0);
    await expect(receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 1 })).rejects.toBeInstanceOf(PositionOccupiedError);
    await assertLedgerMatchesBalances();
  });
});

describe("reservations", () => {
  it("9: a position with reserved stock stays with its product; other products cannot enter by any operation", async () => {
    const { ctx, aiko, ja, P01, P02 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await createReservation(ctx, { lines: [{ productId: aiko.id, positionId: P01.id, quantity: 5 }] }); // available is now 0

    await expect(receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 1 })).rejects.toBeInstanceOf(PositionOccupiedError);
    await expect(adjustStock(ctx, { productId: ja.id, positionId: P01.id, delta: 1, reason: "x" })).rejects.toBeInstanceOf(PositionOccupiedError);
    await receiveStock(ctx, { productId: ja.id, positionId: P02.id, quantity: 2 });
    await expect(moveStock(ctx, { productId: ja.id, fromPositionId: P02.id, toPositionId: P01.id, quantity: 1 })).rejects.toBeInstanceOf(PositionOccupiedError);

    // the reserved stock cannot be taken out to free the position either
    await expect(adjustStock(ctx, { productId: aiko.id, positionId: P01.id, delta: -5, reason: "x" })).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await balance(P01.id, aiko.id)).toMatchObject({ onHand: 5, reserved: 5 });
  });

  it("reserving can never create occupancy: it needs existing stock of that product", async () => {
    const { ctx, aiko, ja, P01 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await expect(createReservation(ctx, { lines: [{ productId: ja.id, positionId: P01.id, quantity: 1 }] })).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await balance(P01.id, ja.id)).toBeNull();
  });

  it("after the reservation is released and the stock removed, the position opens up again", async () => {
    const { ctx, aiko, ja, P01 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    const r = await createReservation(ctx, { lines: [{ productId: aiko.id, positionId: P01.id, quantity: 5 }] });
    const { releaseReservation } = await import("..");
    await releaseReservation(ctx, { reservationId: r.reservationId });
    await adjustStock(ctx, { productId: aiko.id, positionId: P01.id, delta: -5, reason: "gone" });
    await expect(receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 1 })).resolves.toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("10: the rule is scoped to real positions: other organizations are unaffected and cannot reach this one", async () => {
    const a = await setup();
    const b = await tenantWithWarehouse("ob");
    const bProduct = await makeProduct(b.ctx, "AIKO-SOLAR"); // same SKU in another organization
    await receiveStock(a.ctx, { productId: a.aiko.id, positionId: a.P01.id, quantity: 5 });

    // B's same-coded position is a different position: free to use
    const bP01 = b.byCode("R01-L01-B01-P01");
    await expect(receiveStock(b.ctx, { productId: bProduct.id, positionId: bP01.id, quantity: 3 })).resolves.toBeTruthy();
    // B cannot touch A's position, and A's product cannot be placed in B's
    await expect(receiveStock(b.ctx, { productId: bProduct.id, positionId: a.P01.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveStock(a.ctx, { productId: a.ja.id, positionId: bP01.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    expect((await balance(a.P01.id, a.aiko.id))?.onHand).toBe(5);
  });
});

describe("database backstop (cannot be bypassed by going around the service)", () => {
  it("rejects a second product with positive stock on a position, whichever way it is written", async () => {
    const { org, ctx, aiko, ja, P01, warehouseId } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    const base = { organizationId: org.organization.id, warehouseId, positionId: P01.id };

    await expect(prisma.inventoryBalance.create({ data: { ...base, productId: ja.id, onHand: 1 } })).rejects.toMatchObject({ code: "P2002" });

    // a zero row for another product is allowed (it is not occupancy) ...
    await prisma.inventoryBalance.create({ data: { ...base, productId: ja.id, onHand: 0 } });
    // ... but raising it above zero while the position is occupied is not
    await expect(prisma.inventoryBalance.updateMany({ where: { positionId: P01.id, productId: ja.id }, data: { onHand: 2 } })).rejects.toMatchObject({ code: "P2002" });
    expect((await stockAt(P01.id)).map((b) => b.productId)).toEqual([aiko.id]);
  });

  it("the guarded SQL itself (no service pre-check) is refused by the index and reported as POSITION_OCCUPIED", async () => {
    const { ctx, aiko, ja, P01, warehouseId } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    const raw = await inventoryRepo(ctx).receiveInto({ warehouseId, positionId: P01.id, productId: ja.id, qty: 1 }).catch((e) => e);
    expect(raw).toBeInstanceOf(Error);
    expect(normalizeError(raw)).toBeInstanceOf(PositionOccupiedError);
    expect(await balance(P01.id, ja.id)).toBeNull();
  });

  it("two products may both have zero rows on the same position, and the first to go positive wins", async () => {
    const { org, aiko, ja, P01, warehouseId } = await setup();
    const base = { organizationId: org.organization.id, warehouseId, positionId: P01.id, onHand: 0 };
    await prisma.inventoryBalance.createMany({ data: [{ ...base, productId: aiko.id }, { ...base, productId: ja.id }] });
    await prisma.inventoryBalance.updateMany({ where: { productId: ja.id }, data: { onHand: 3 } });
    await expect(prisma.inventoryBalance.updateMany({ where: { productId: aiko.id }, data: { onHand: 1 } })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("concurrency", () => {
  it("11: two products racing for the same empty position: only one can win, never both", async () => {
    const { ctx, aiko, ja, P01 } = await setup();
    const ops: { sku: string; p: Promise<unknown> }[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push({ sku: "AIKO", p: receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 1 }) });
      ops.push({ sku: "JA", p: receiveStock(ctx, { productId: ja.id, positionId: P01.id, quantity: 1 }) });
    }
    const results = await Promise.allSettled(ops.map((o) => o.p));

    const winners = new Set<string>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") winners.add(ops[i].sku);
      else expect(r.reason).toBeInstanceOf(PositionOccupiedError); // the only acceptable failure
    });
    expect(winners.size).toBe(1);

    const stock = await stockAt(P01.id);
    expect(stock).toHaveLength(1);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    // The winning product must succeed on ALL of its requests (no spurious failures for the same
    // product), and the losing product on none.
    expect(wins).toBe(10);
    expect(stock[0].onHand).toBe(wins);
    await assertLedgerMatchesBalances();
  });

  it("two moves of different products into the same empty position: exactly one succeeds, the loser's source stock is untouched", async () => {
    const { ctx, aiko, ja, P01, P02, P03 } = await setup();
    await receiveStock(ctx, { productId: aiko.id, positionId: P01.id, quantity: 5 });
    await receiveStock(ctx, { productId: ja.id, positionId: P02.id, quantity: 5 });
    const results = await Promise.allSettled([
      moveStock(ctx, { productId: aiko.id, fromPositionId: P01.id, toPositionId: P03.id, quantity: 5 }),
      moveStock(ctx, { productId: ja.id, fromPositionId: P02.id, toPositionId: P03.id, quantity: 5 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(PositionOccupiedError);
    expect(await stockAt(P03.id)).toHaveLength(1);
    // total stock is conserved: whoever lost still has all 5 at its source
    const total = (await prisma.inventoryBalance.findMany()).reduce((n, b) => n + b.onHand, 0);
    expect(total).toBe(10);
    await assertLedgerMatchesBalances();
  });

  it("many mixed operations on a few positions never leave two products on one position", async () => {
    const { ctx, aiko, ja, P01, P02, P03 } = await setup();
    const spots = [P01, P02, P03];
    const products = [aiko, ja];
    let seed = 11;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const p = products[rnd(2)];
      const from = spots[rnd(3)];
      const to = spots[rnd(3)];
      switch (rnd(3)) {
        case 0: ops.push(receiveStock(ctx, { productId: p.id, positionId: from.id, quantity: 1 + rnd(3) })); break;
        case 1: if (from.id !== to.id) ops.push(moveStock(ctx, { productId: p.id, fromPositionId: from.id, toPositionId: to.id, quantity: 1 + rnd(3) })); break;
        default: ops.push(adjustStock(ctx, { productId: p.id, positionId: from.id, delta: rnd(2) ? -(1 + rnd(3)) : 1 + rnd(3), reason: "storm" }));
      }
    }
    const results = await Promise.allSettled(ops);
    for (const r of results) {
      if (r.status === "rejected") expect([InsufficientStockError, PositionOccupiedError].some((E) => r.reason instanceof E)).toBe(true);
    }
    const rows = await prisma.$queryRaw<{ positionId: string; n: bigint }[]>`
      SELECT "positionId", count(*) n FROM "InventoryBalance" WHERE "onHand" > 0 GROUP BY 1 HAVING count(*) > 1`;
    expect(rows).toEqual([]);
    await assertLedgerMatchesBalances();
  });
});

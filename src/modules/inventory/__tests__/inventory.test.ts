import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertLedgerMatchesBalances, ctxWithRole, makeProduct, newTenant, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AuthorizationError, ConflictError, InsufficientStockError, NotFoundError, ValidationError } from "@/lib/errors";
import { updateProduct } from "@/modules/catalog";
import { adjustStock, listMovements, listStock, moveStock, receiveStock } from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse();
  const product = await makeProduct(t.ctx);
  return { ...t, product, A: t.byCode("R01-L01-B01-P01"), B: t.byCode("R01-L01-B02-P01"), C: t.byCode("R01-L02-B03-P01") };
}

async function balance(positionId: string, productId: string) {
  return prisma.inventoryBalance.findFirst({ where: { positionId, productId } });
}

describe("receiving stock", () => {
  it("adds on-hand at a real position and writes one RECEIVE movement", async () => {
    const { ctx, product, A } = await setup();
    const r = await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 10, reason: "PO 1" });
    expect(r.replayed).toBe(false);
    expect(r.movements).toHaveLength(1);
    expect(r.movements[0]).toMatchObject({ type: "RECEIVE", qtyDelta: 10, reservedDelta: 0, onHandAfter: 10, reservedAfter: 0, positionCode: "R01-L01-B01-P01", reason: "PO 1" });

    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    const b = await balance(A.id, product.id);
    expect([b?.onHand, b?.reserved]).toEqual([15, 0]);
    expect(await prisma.inventoryMovement.count()).toBe(2);
    await assertLedgerMatchesBalances();
  });

  it("stock references the real Position row, in the right warehouse, with the actor recorded", async () => {
    const { ctx, org, product, A, warehouseId } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 3 });
    const b = await prisma.inventoryBalance.findFirstOrThrow({ include: { position: true } });
    expect(b.position.id).toBe(A.id);
    expect(b.warehouseId).toBe(warehouseId);
    expect(b.organizationId).toBe(org.organization.id);
    const op = await prisma.inventoryOperation.findFirstOrThrow();
    expect(op.actorUserId).toBe(ctx.userId);
  });

  it("validates quantities and ids on the server", async () => {
    const { ctx, product, A } = await setup();
    for (const quantity of [0, -5, 1.5, "10", null, 1_000_000_000]) {
      await expect(receiveStock(ctx, { productId: product.id, positionId: A.id, quantity })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(receiveStock(ctx, { productId: "nope", positionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.inventoryBalance.count()).toBe(0);
  });

  it("rejects unknown positions/products and disabled products", async () => {
    const { ctx, product, A } = await setup();
    const missing = "00000000-0000-4000-8000-000000000000";
    await expect(receiveStock(ctx, { productId: product.id, positionId: missing, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveStock(ctx, { productId: missing, positionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await updateProduct(ctx, product.id, { active: false });
    await expect(receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("the database refuses a balance above the cap (overflow protection)", async () => {
    const { ctx, product, A } = await setup();
    for (let i = 0; i < 10; i++) await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 100_000_000 });
    await expect(receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(ValidationError);
    expect((await balance(A.id, product.id))?.onHand).toBe(1_000_000_000);
  });
});

describe("moving stock", () => {
  it("moves between positions, writing paired movements; totals are conserved", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 10 });
    const r = await moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 4, reason: "consolidate" });

    expect(r.movements).toHaveLength(2);
    const out = r.movements.find((m) => m.qtyDelta < 0)!;
    const inn = r.movements.find((m) => m.qtyDelta > 0)!;
    expect(out).toMatchObject({ type: "MOVE", positionCode: A.code, counterpartPositionCode: B.code, qtyDelta: -4, onHandAfter: 6 });
    expect(inn).toMatchObject({ type: "MOVE", positionCode: B.code, counterpartPositionCode: A.code, qtyDelta: 4, onHandAfter: 4 });
    expect(out.operationId).toBe(inn.operationId);
    expect((await balance(A.id, product.id))?.onHand).toBe(6);
    expect((await balance(B.id, product.id))?.onHand).toBe(4);
    await assertLedgerMatchesBalances();
  });

  it("rejects moving more than the source has, and changes nothing", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 3 });
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 4 })).rejects.toBeInstanceOf(InsufficientStockError);
    expect((await balance(A.id, product.id))?.onHand).toBe(3);
    expect(await balance(B.id, product.id)).toBeNull();
    expect(await prisma.inventoryMovement.count()).toBe(1); // only the receive
    // moving from a position that never had the product
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: B.id, toPositionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it("cannot move reserved stock (only AVAILABLE stock moves)", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 10 });
    await prisma.inventoryBalance.updateMany({ where: { positionId: A.id }, data: { reserved: 8 } }); // direct setup of a reserved state
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 3 })).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 2 })).resolves.toBeTruthy();
    expect((await balance(A.id, product.id))).toMatchObject({ onHand: 8, reserved: 8 });
  });

  it("validates source/destination", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: "00000000-0000-4000-8000-000000000000", quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: A.id, quantity: 0 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("adjusting stock", () => {
  it("adjusts up (ADJUSTMENT_IN) and down (ADJUSTMENT_OUT), reason required", async () => {
    const { ctx, product, A } = await setup();
    const up = await adjustStock(ctx, { productId: product.id, positionId: A.id, delta: 7, reason: "count +7" });
    expect(up.movements[0]).toMatchObject({ type: "ADJUSTMENT_IN", qtyDelta: 7, onHandAfter: 7 });
    const down = await adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -3, reason: "damaged" });
    expect(down.movements[0]).toMatchObject({ type: "ADJUSTMENT_OUT", qtyDelta: -3, onHandAfter: 4, reason: "damaged" });
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: 1 })).rejects.toBeInstanceOf(ValidationError);
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: 0, reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    await assertLedgerMatchesBalances();
  });

  it("never goes below zero, and never cuts into reserved stock", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -6, reason: "oops" })).rejects.toBeInstanceOf(InsufficientStockError);
    await prisma.inventoryBalance.updateMany({ where: { positionId: A.id }, data: { reserved: 4 } });
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -2, reason: "oops" })).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -1, reason: "ok" })).resolves.toBeTruthy();
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 4, reserved: 4 });
  });

  it("a disabled product can be reduced or moved but not increased", async () => {
    const { ctx, product, A, B } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    await updateProduct(ctx, product.id, { active: false });
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: 1, reason: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -1, reason: "x" })).resolves.toBeTruthy();
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 1 })).resolves.toBeTruthy();
  });
});

describe("reads", () => {
  it("lists stock with on-hand, reserved and available, and filters by product/position/search", async () => {
    const { ctx, product, A, B } = await setup();
    const other = await makeProduct(ctx, "OTHER-1");
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 10 });
    await receiveStock(ctx, { productId: other.id, positionId: B.id, quantity: 2 });
    await prisma.inventoryBalance.updateMany({ where: { positionId: A.id }, data: { reserved: 3 } });

    const all = await listStock(ctx);
    expect(all).toHaveLength(2);
    const row = all.find((r) => r.productId === product.id)!;
    expect(row).toMatchObject({ onHand: 10, reserved: 3, available: 7, positionCode: A.code, warehouseCode: "MAIN", sku: product.sku });
    expect(await listStock(ctx, { productId: other.id })).toHaveLength(1);
    expect(await listStock(ctx, { positionId: A.id })).toHaveLength(1);
    expect(await listStock(ctx, { search: "other" })).toHaveLength(1);
  });

  it("hides empty balances but keeps full history in movements", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 2 });
    await adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -2, reason: "gone" });
    expect(await listStock(ctx)).toHaveLength(0);
    const history = await listMovements(ctx, { productId: product.id });
    expect(history.map((m) => m.type)).toEqual(["ADJUSTMENT_OUT", "RECEIVE"]);
  });
});

describe("movement ledger is append-only and balances are protected by the database", () => {
  it("rejects UPDATE and DELETE on movements and operations", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    await expect(prisma.inventoryMovement.updateMany({ data: { qtyDelta: 999 } })).rejects.toBeTruthy();
    await expect(prisma.inventoryMovement.deleteMany({})).rejects.toBeTruthy();
    await expect(prisma.inventoryOperation.updateMany({ data: { reason: "tampered" } })).rejects.toBeTruthy();
    await expect(prisma.inventoryOperation.deleteMany({})).rejects.toBeTruthy();
    expect(await prisma.inventoryMovement.count()).toBe(1);
    expect((await prisma.inventoryMovement.findFirstOrThrow()).qtyDelta).toBe(5);
  });

  it("CHECK constraints refuse negative on-hand, negative reserved and reserved > on-hand", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });
    await expect(prisma.inventoryBalance.updateMany({ data: { onHand: -1 } })).rejects.toBeTruthy();
    await expect(prisma.inventoryBalance.updateMany({ data: { reserved: -1 } })).rejects.toBeTruthy();
    await expect(prisma.inventoryBalance.updateMany({ data: { reserved: 6 } })).rejects.toBeTruthy();
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 5, reserved: 0 });
  });

  it("the database enforces the movement sign pattern per type", async () => {
    const { ctx, org, product, A, warehouseId } = await setup();
    const op = await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 1 });
    await expect(
      prisma.inventoryMovement.create({
        data: {
          organizationId: org.organization.id, operationId: op.operationId, type: "RECEIVE", warehouseId, productId: product.id,
          positionId: A.id, positionCode: A.code, qtyDelta: -1, reservedDelta: 0, onHandAfter: 0, reservedAfter: 0,
        },
      }),
    ).rejects.toBeTruthy();
  });
});

describe("tenant isolation", () => {
  it("organization B cannot receive, move or adjust using A's products or positions", async () => {
    const a = await setup();
    const b = await newTenant("b");
    const bt = await tenantWithWarehouse("bw");
    const bProduct = await makeProduct(bt.ctx);

    await receiveStock(a.ctx, { productId: a.product.id, positionId: a.A.id, quantity: 5 });

    // B's product at A's position, A's product at B's position, and both foreign
    await expect(receiveStock(bt.ctx, { productId: bProduct.id, positionId: a.A.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(receiveStock(bt.ctx, { productId: a.product.id, positionId: bt.byCode("R01-L01-B01-P01").id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(moveStock(bt.ctx, { productId: a.product.id, fromPositionId: a.A.id, toPositionId: a.B.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(adjustStock(bt.ctx, { productId: a.product.id, positionId: a.A.id, delta: -1, reason: "steal" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(moveStock(bt.ctx, { productId: bProduct.id, fromPositionId: bt.byCode("R01-L01-B01-P01").id, toPositionId: a.B.id, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);

    expect((await balance(a.A.id, a.product.id))?.onHand).toBe(5);
    expect(await listStock(b.ctx)).toEqual([]);
    expect(await listStock(bt.ctx)).toEqual([]);
    expect(await listMovements(bt.ctx)).toEqual([]);
  });

  it("the database refuses a balance whose position or product belongs to another organization", async () => {
    const a = await setup();
    const b = await tenantWithWarehouse("bw");
    const bProduct = await makeProduct(b.ctx);
    // A's org id, B's position (composite FK to Position(organizationId, warehouseId, id))
    await expect(
      prisma.inventoryBalance.create({
        data: { organizationId: a.org.organization.id, warehouseId: b.warehouseId, positionId: b.byCode("R01-L01-B01-P01").id, productId: a.product.id, onHand: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    // A's position with B's product
    await expect(
      prisma.inventoryBalance.create({
        data: { organizationId: a.org.organization.id, warehouseId: a.warehouseId, positionId: a.A.id, productId: bProduct.id, onHand: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    // A position paired with the wrong warehouse
    await expect(
      prisma.inventoryBalance.create({
        data: { organizationId: a.org.organization.id, warehouseId: b.warehouseId, positionId: a.A.id, productId: a.product.id, onHand: 1 },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("authorization", () => {
  it("Member can view inventory but cannot receive, move, adjust or reserve; Admin can", async () => {
    const { org, ctx, product, A, B } = await setup();
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5 });

    await expect(listStock(member)).resolves.toHaveLength(1);
    await expect(listMovements(member)).resolves.toHaveLength(1);
    await expect(receiveStock(member, { productId: product.id, positionId: A.id, quantity: 1 })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(moveStock(member, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 1 })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(adjustStock(member, { productId: product.id, positionId: A.id, delta: -1, reason: "x" })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(receiveStock(admin, { productId: product.id, positionId: A.id, quantity: 1 })).resolves.toBeTruthy();
    expect(await prisma.inventoryMovement.count()).toBe(2);
  });
});

describe("idempotency", () => {
  it("applies a keyed request once and returns the original result on replay", async () => {
    const { ctx, product, A } = await setup();
    const req = { productId: product.id, positionId: A.id, quantity: 5, idempotencyKey: "recv-2026-0001" };
    const first = await receiveStock(ctx, req);
    const again = await receiveStock(ctx, req);
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.operationId).toBe(first.operationId);
    expect((await balance(A.id, product.id))?.onHand).toBe(5);
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });

  it("rejects reusing a key with a different request", async () => {
    const { ctx, product, A } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 5, idempotencyKey: "key-12345678" });
    await expect(receiveStock(ctx, { productId: product.id, positionId: A.id, quantity: 6, idempotencyKey: "key-12345678" })).rejects.toBeInstanceOf(ConflictError);
    expect((await balance(A.id, product.id))?.onHand).toBe(5);
  });

  it("concurrent requests with the same key are applied exactly once", async () => {
    const { ctx, product, A } = await setup();
    const req = { productId: product.id, positionId: A.id, quantity: 7, idempotencyKey: "concurrent-key-1" };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => receiveStock(ctx, req)));
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect((await balance(A.id, product.id))?.onHand).toBe(7);
    expect(await prisma.inventoryOperation.count()).toBe(1);
    await assertLedgerMatchesBalances();
  });

  it("keys are scoped per organization", async () => {
    const a = await setup();
    const b = await tenantWithWarehouse("bw");
    const bp = await makeProduct(b.ctx);
    await receiveStock(a.ctx, { productId: a.product.id, positionId: a.A.id, quantity: 1, idempotencyKey: "shared-key-1" });
    const r = await receiveStock(b.ctx, { productId: bp.id, positionId: b.byCode("R01-L01-B01-P01").id, quantity: 2, idempotencyKey: "shared-key-1" });
    expect(r.replayed).toBe(false);
  });
});

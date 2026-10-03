import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertLedgerMatchesBalances, ctxWithRole, makeProduct, newTenant, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AuthorizationError, ConflictError, InsufficientStockError, NotFoundError, ValidationError } from "@/lib/errors";
import { adjustStock, createReservation, getReservation, listReservations, listStock, moveStock, receiveStock, releaseReservation } from "..";

beforeEach(resetDatabase);

async function setup(stock = 10) {
  const t = await tenantWithWarehouse();
  const product = await makeProduct(t.ctx);
  const A = t.byCode("R01-L01-B01-P01");
  const B = t.byCode("R01-L01-B02-P01");
  if (stock > 0) await receiveStock(t.ctx, { productId: product.id, positionId: A.id, quantity: stock });
  return { ...t, product, A, B };
}
const balance = (positionId: string, productId: string) => prisma.inventoryBalance.findFirstOrThrow({ where: { positionId, productId } });

describe("creating reservations", () => {
  it("increases reserved, lowers available, and records RESERVE movements", async () => {
    const { ctx, product, A } = await setup(10);
    const r = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 4 }], note: "order 7", refType: "ORDER", refId: "7" });
    expect(r.reservationId).toBeTruthy();
    expect(r.movements[0]).toMatchObject({ type: "RESERVE", qtyDelta: 0, reservedDelta: 4, onHandAfter: 10, reservedAfter: 4 });
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 10, reserved: 4 });

    const row = (await listStock(ctx))[0];
    expect([row.onHand, row.reserved, row.available]).toEqual([10, 4, 6]);

    const res = await getReservation(ctx, r.reservationId!);
    expect(res).toMatchObject({ status: "ACTIVE", refType: "ORDER", refId: "7", note: "order 7" });
    expect(res.lines).toEqual([{ productId: product.id, sku: product.sku, positionId: A.id, positionCode: A.code, quantity: 4 }]);
    await assertLedgerMatchesBalances();
  });

  it("refuses to reserve more than AVAILABLE and changes nothing", async () => {
    const { ctx, product, A } = await setup(10);
    await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 7 }] });
    await expect(createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 4 }] })).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 10, reserved: 7 });
    expect(await prisma.reservation.count()).toBe(1);
    expect(await prisma.inventoryMovement.count()).toBe(2); // receive + first reserve only
    await expect(createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 3 }] })).resolves.toBeTruthy();
  });

  it("a multi-line reservation is all-or-nothing", async () => {
    const { ctx, product, A, B } = await setup(10);
    await expect(
      createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 5 }, { productId: product.id, positionId: B.id, quantity: 1 }] }),
    ).rejects.toBeInstanceOf(InsufficientStockError); // B has no stock
    expect(await balance(A.id, product.id)).toMatchObject({ reserved: 0 });
    expect(await prisma.reservation.count()).toBe(0);
  });

  it("validates input: positive integer quantities, no duplicate lines, at least one line", async () => {
    const { ctx, product, A } = await setup(10);
    const line = { productId: product.id, positionId: A.id, quantity: 1 };
    await expect(createReservation(ctx, { lines: [] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReservation(ctx, { lines: [{ ...line, quantity: 0 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReservation(ctx, { lines: [{ ...line, quantity: 1.5 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReservation(ctx, { lines: [line, line] })).rejects.toBeInstanceOf(ValidationError);
  });

  it("reserved stock is protected from moves and adjustments", async () => {
    const { ctx, product, A, B } = await setup(10);
    await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 8 }] });
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 3 })).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(adjustStock(ctx, { productId: product.id, positionId: A.id, delta: -3, reason: "x" })).rejects.toBeInstanceOf(InsufficientStockError);
    await expect(moveStock(ctx, { productId: product.id, fromPositionId: A.id, toPositionId: B.id, quantity: 2 })).resolves.toBeTruthy();
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 8, reserved: 8 });
  });
});

describe("releasing reservations", () => {
  it("restores available stock and records RELEASE movements", async () => {
    const { ctx, product, A } = await setup(10);
    const made = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 6 }] });
    const rel = await releaseReservation(ctx, { reservationId: made.reservationId });
    expect(rel.movements[0]).toMatchObject({ type: "RELEASE", qtyDelta: 0, reservedDelta: -6, onHandAfter: 10, reservedAfter: 0 });
    expect(await balance(A.id, product.id)).toMatchObject({ onHand: 10, reserved: 0 });
    expect((await getReservation(ctx, made.reservationId!)).status).toBe("RELEASED");
    expect((await getReservation(ctx, made.reservationId!)).releasedAt).toBeTruthy();
    await assertLedgerMatchesBalances();
  });

  it("cannot be released twice (no over-release)", async () => {
    const { ctx, product, A } = await setup(10);
    const a = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 3 }] });
    const b = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 4 }] });
    await releaseReservation(ctx, { reservationId: a.reservationId });
    await expect(releaseReservation(ctx, { reservationId: a.reservationId })).rejects.toBeInstanceOf(ConflictError);
    // b's reservation is untouched by the failed double release
    expect(await balance(A.id, product.id)).toMatchObject({ reserved: 4 });
    expect((await getReservation(ctx, b.reservationId!)).status).toBe("ACTIVE");
  });

  it("concurrent releases of one reservation release it exactly once", async () => {
    const { ctx, product, A } = await setup(10);
    const made = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 5 }] });
    const other = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 2 }] });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => releaseReservation(ctx, { reservationId: made.reservationId })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await balance(A.id, product.id)).toMatchObject({ reserved: 2 });
    expect((await getReservation(ctx, other.reservationId!)).status).toBe("ACTIVE");
    await assertLedgerMatchesBalances();
  });

  it("lists reservations by status; unknown ids are not found; retried release is idempotent with a key", async () => {
    const { ctx, product, A } = await setup(10);
    const made = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 1 }] });
    expect(await listReservations(ctx, "ACTIVE")).toHaveLength(1);
    await releaseReservation(ctx, { reservationId: made.reservationId, idempotencyKey: "release-key-1" });
    const again = await releaseReservation(ctx, { reservationId: made.reservationId, idempotencyKey: "release-key-1" });
    expect(again.replayed).toBe(true);
    expect(await listReservations(ctx, "ACTIVE")).toHaveLength(0);
    expect(await listReservations(ctx, "RELEASED")).toHaveLength(1);
    await expect(releaseReservation(ctx, { reservationId: "00000000-0000-4000-8000-000000000000" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("tenant isolation and authorization", () => {
  it("another organization can neither reserve against nor release nor read a reservation", async () => {
    const a = await setup(10);
    const b = await newTenant("b");
    const made = await createReservation(a.ctx, { lines: [{ productId: a.product.id, positionId: a.A.id, quantity: 3 }] });

    await expect(createReservation(b.ctx, { lines: [{ productId: a.product.id, positionId: a.A.id, quantity: 1 }] })).rejects.toBeInstanceOf(NotFoundError);
    await expect(releaseReservation(b.ctx, { reservationId: made.reservationId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(getReservation(b.ctx, made.reservationId!)).rejects.toBeInstanceOf(NotFoundError);
    expect(await listReservations(b.ctx)).toEqual([]);
    expect(await balance(a.A.id, a.product.id)).toMatchObject({ reserved: 3 });
  });

  it("Member cannot reserve or release; Admin can", async () => {
    const { org, product, A } = await setup(10);
    const member = await ctxWithRole(org, "Member");
    const admin = await ctxWithRole(org, "Admin");
    const line = { productId: product.id, positionId: A.id, quantity: 1 };
    await expect(createReservation(member, { lines: [line] })).rejects.toBeInstanceOf(AuthorizationError);
    const made = await createReservation(admin, { lines: [line] });
    await expect(releaseReservation(member, { reservationId: made.reservationId })).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listReservations(member)).resolves.toHaveLength(1);
  });

  it("a reservation line quantity must be positive in the database too", async () => {
    const { org, product, A, ctx } = await setup(10);
    const made = await createReservation(ctx, { lines: [{ productId: product.id, positionId: A.id, quantity: 1 }] });
    await expect(
      prisma.reservationLine.create({ data: { organizationId: org.organization.id, reservationId: made.reservationId!, productId: product.id, positionId: B_ID(A), positionCode: "X", quantity: 0 } }),
    ).rejects.toBeTruthy();
  });
});

// A position id different from A's, only used to avoid the unique (reservation, position, product) constraint.
function B_ID(a: { id: string }) {
  return a.id.replace(/.$/, a.id.endsWith("0") ? "1" : "0");
}

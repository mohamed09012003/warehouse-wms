import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPackingInvariants, inventorySnapshot, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { InvalidStateError, NotFoundError, PackQuantityError, ValidationError, WrongProductError } from "@/lib/errors";
import { addBarcode } from "@/modules/catalog";
import { getOrder } from "@/modules/orders";
import {
  addPackageItem,
  cancelPackage,
  completePackage,
  createPackage,
  getPackingSession,
  removePackageItem,
  setPackageItemQuantity,
  startPacking,
  updatePackage,
} from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("pk", { bays: 3, levels: 1 });
  const a = await makeProduct(t.ctx, "SKU-A");
  const b = await makeProduct(t.ctx, "SKU-B");
  await stockAt(t.ctx, a.id, t.byCode("R01-L01-B01-P01").id, 20);
  await stockAt(t.ctx, b.id, t.byCode("R01-L01-B02-P01").id, 20);
  const order = await makeOrder(t.ctx, [{ productId: a.id, quantity: 10 }, { productId: b.id, quantity: 4 }]);
  await pickOrder(t.ctx, order.id);
  const s = await startPacking(t.ctx, { orderId: order.id });
  return { ...t, a, b, order, sessionId: s.session.id };
}
const line = async (ctx: Parameters<typeof getPackingSession>[0], sessionId: string, sku: string) => (await getPackingSession(ctx, sessionId)).lines.find((l) => l.sku === sku)!;

describe("creating packages", () => {
  it("creates OPEN packages numbered 1, 2, 3 per order, with optional integer weight (g) and dimensions (mm)", async () => {
    const { ctx, sessionId } = await setup();
    const p1 = await createPackage(ctx, { sessionId });
    const p2 = await createPackage(ctx, { sessionId, packageType: "Box M", weightG: 2500, lengthMm: 400, widthMm: 300, heightMm: 200 });
    const p3 = await createPackage(ctx, { sessionId });
    expect(p3.session.packages.map((p) => [p.packageNumber, p.status])).toEqual([[1, "OPEN"], [2, "OPEN"], [3, "OPEN"]]);
    expect(p2.session.packages[1]).toMatchObject({ packageType: "Box M", weightG: 2500, lengthMm: 400, widthMm: 300, heightMm: 200, totalQuantity: 0 });
    expect(p1.session.packages[0]).toMatchObject({ packageType: null, weightG: null, lengthMm: null });
    const row = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect([row.weightG, row.lengthMm, row.widthMm, row.heightMm]).toEqual([2500, 400, 300, 200]);
    expect(row.sessionId).toBe(sessionId); // belongs to the session and its order
  });

  it("rejects non-integer, zero, negative and partial measures (server and database)", async () => {
    const { ctx, org, sessionId } = await setup();
    for (const bad of [{ weightG: 0 }, { weightG: -5 }, { weightG: 1.5 }, { weightG: "3kg" }, { lengthMm: 0, widthMm: 1, heightMm: 1 }, { lengthMm: 10.5, widthMm: 1, heightMm: 1 }, { lengthMm: 100, widthMm: 100 }, { lengthMm: -1, widthMm: 1, heightMm: 1 }, { packageType: "" }]) {
      await expect(createPackage(ctx, { sessionId, ...bad })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await prisma.package.count()).toBe(0);
    const order = await prisma.order.findFirstOrThrow();
    const base = { organizationId: org.organization.id, sessionId, orderId: order.id, packageNumber: 1 };
    await expect(prisma.package.create({ data: { ...base, weightG: 0 } })).rejects.toBeTruthy();
    await expect(prisma.package.create({ data: { ...base, lengthMm: 10, widthMm: 10 } })).rejects.toBeTruthy(); // dimensions come as a set
    await expect(prisma.package.create({ data: { ...base, heightMm: -1, lengthMm: 1, widthMm: 1 } })).rejects.toBeTruthy();
  });

  it("can update details while OPEN, but not after completion", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p.packageId!, productCode: "SKU-A", quantity: 2 });
    const up = await updatePackage(ctx, { packageId: p.packageId, packageType: "Pallet", weightG: 12000, lengthMm: 1200, widthMm: 800, heightMm: 900 });
    expect(up.session.packages[0]).toMatchObject({ packageType: "Pallet", weightG: 12000, lengthMm: 1200 });
    await completePackage(ctx, { packageId: p.packageId });
    await expect(updatePackage(ctx, { packageId: p.packageId, weightG: 1 })).rejects.toBeInstanceOf(InvalidStateError);
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } })).weightG).toBe(12000);
  });
});

describe("adding picked quantity", () => {
  it("adds items, identified by SKU or barcode; adding the same line again increases the quantity", async () => {
    const { ctx, a, sessionId } = await setup();
    await addBarcode(ctx, a.id, { barcode: "4006381333931" });
    const p = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p.packageId, productCode: "sku-a", quantity: 3 });
    const r = await addPackageItem(ctx, { packageId: p.packageId, productCode: "4006381333931", quantity: 2 });
    expect(r.session.packages[0].items).toEqual([expect.objectContaining({ sku: "SKU-A", quantity: 5 })]);
    expect(r.session.packages[0].totalQuantity).toBe(5);
    expect(await line(ctx, sessionId, "SKU-A")).toMatchObject({ pickedQty: 10, packedQty: 5, remainingQty: 5 });
    await assertPackingInvariants();
  });

  it("rejects zero, negative and fractional quantities", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    for (const quantity of [0, -3, 1.5, "2", null]) {
      await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity })).rejects.toBeInstanceOf(ValidationError);
    }
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(0);
  });

  it("rejects quantity above the remaining picked quantity (6 packed + 5 more of 10 picked), with a clear message", async () => {
    const { ctx, sessionId } = await setup();
    const p1 = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 6 });
    const p2 = await createPackage(ctx, { sessionId });
    const err = await addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(PackQuantityError);
    expect(err.code).toBe("PACK_QUANTITY_EXCEEDED");
    expect(err.message).toMatch(/Only 4 of SKU-A/);
    await expect(addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 4 })).resolves.toBeTruthy();
    await expect(addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 1 })).rejects.toBeInstanceOf(PackQuantityError);
    expect(await line(ctx, sessionId, "SKU-A")).toMatchObject({ pickedQty: 10, packedQty: 10, remainingQty: 0 });
    await assertPackingInvariants();
  });

  it("packs one order across several packages (6 + 4) and never more than picked in total", async () => {
    const { ctx, sessionId } = await setup();
    const p1 = await createPackage(ctx, { sessionId });
    const p2 = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 6 });
    await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-B", quantity: 4 });
    await addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 4 });
    await expect(addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 1 })).rejects.toBeInstanceOf(PackQuantityError);
    await expect(addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-B", quantity: 1 })).rejects.toBeInstanceOf(PackQuantityError);
    const s = await getPackingSession(ctx, sessionId);
    expect(s).toMatchObject({ pickedTotal: 14, packedTotal: 14, remainingTotal: 0 });
    expect(s.packages.map((p) => p.totalQuantity)).toEqual([10, 4]);
    await assertPackingInvariants();
  });

  it("rejects a product that is not on the order, an unknown product, and a mismatched order line", async () => {
    const { ctx, sessionId } = await setup();
    const other = await makeProduct(ctx, "NOT-ON-ORDER");
    const p = await createPackage(ctx, { sessionId });
    await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "NOT-ON-ORDER", quantity: 1 })).rejects.toBeInstanceOf(WrongProductError);
    await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "NO-SUCH", quantity: 1 })).rejects.toBeInstanceOf(WrongProductError);
    const lineB = (await line(ctx, sessionId, "SKU-B")).orderLineId;
    await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", orderLineId: lineB, quantity: 1 })).rejects.toBeInstanceOf(WrongProductError); // SKU-A scanned for SKU-B's line
    await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", orderLineId: "00000000-0000-4000-8000-000000000000", quantity: 1 })).rejects.toBeInstanceOf(WrongProductError);
    expect(other.id).toBeTruthy();
    expect(await prisma.packageItem.count()).toBe(0);
  });

  it("the database ties an item to its package's order and to the line's own product", async () => {
    const { ctx, org, a, b, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    const order = await prisma.order.findFirstOrThrow();
    const lineA = await prisma.orderLine.findFirstOrThrow({ where: { productId: a.id } });
    const base = { organizationId: org.organization.id, packageId: p.packageId!, orderId: order.id, quantity: 1 };
    await expect(prisma.packageItem.create({ data: { ...base, orderLineId: lineA.id, productId: b.id } })).rejects.toMatchObject({ code: "P2003" }); // wrong product for the line
    await expect(prisma.packageItem.create({ data: { ...base, orderLineId: lineA.id, productId: a.id, quantity: 0 } })).rejects.toBeTruthy(); // quantity > 0
    // an order line of a DIFFERENT order cannot be placed in this order's package
    const t2 = await makeOrder(ctx, [{ productId: a.id, quantity: 1 }]);
    const foreignLine = await prisma.orderLine.findFirstOrThrow({ where: { orderId: t2.id } });
    await expect(prisma.packageItem.create({ data: { ...base, orderLineId: foreignLine.id, productId: a.id } })).rejects.toMatchObject({ code: "P2003" });
  });

  it("the database refuses packed > picked even for a direct write", async () => {
    const { ctx, sessionId } = await setup();
    const l = await line(ctx, sessionId, "SKU-A");
    await expect(prisma.orderLine.update({ where: { id: l.orderLineId }, data: { packedQty: 11 } })).rejects.toBeTruthy();
    await expect(prisma.orderLine.update({ where: { id: l.orderLineId }, data: { packedQty: -1 } })).rejects.toBeTruthy();
  });
});

describe("correcting an open package", () => {
  it("changes a quantity up (within picked) and down, and removes an item; the packed counter follows", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    const added = await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 6 });
    const itemId = added.session.packages[0].items[0].id;

    const up = await setPackageItemQuantity(ctx, { itemId, quantity: 9 });
    expect(up.session.packages[0].items[0].quantity).toBe(9);
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(9);
    await expect(setPackageItemQuantity(ctx, { itemId, quantity: 11 })).rejects.toBeInstanceOf(PackQuantityError); // only 10 picked
    const down = await setPackageItemQuantity(ctx, { itemId, quantity: 2 });
    expect(down.session.packages[0].items[0].quantity).toBe(2);
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(2);
    await expect(setPackageItemQuantity(ctx, { itemId, quantity: 0 })).rejects.toBeInstanceOf(ValidationError);

    const gone = await removePackageItem(ctx, { itemId });
    expect(gone.session.packages[0].items).toEqual([]);
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(0);
    await expect(removePackageItem(ctx, { itemId })).rejects.toBeInstanceOf(NotFoundError);
    await assertPackingInvariants();
  });

  it("corrections never create inventory movements or change stock", async () => {
    const { ctx, sessionId } = await setup();
    const before = await inventorySnapshot();
    const p = await createPackage(ctx, { sessionId });
    const added = await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 6 });
    const itemId = added.session.packages[0].items[0].id;
    await setPackageItemQuantity(ctx, { itemId, quantity: 3 });
    await removePackageItem(ctx, { itemId });
    await cancelPackage(ctx, { packageId: p.packageId });
    expect(await inventorySnapshot()).toBe(before);
  });

  it("an OPEN package can be cancelled: its quantity is unpacked again and it keeps its number", async () => {
    const { ctx, sessionId } = await setup();
    const p1 = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 5 });
    const r = await cancelPackage(ctx, { packageId: p1.packageId });
    expect(r.session.packages[0]).toMatchObject({ status: "CANCELLED", packageNumber: 1 });
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(0);
    const p2 = await createPackage(ctx, { sessionId });
    expect(p2.session.packages.map((p) => p.packageNumber)).toEqual([1, 2]);
    await expect(addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 1 })).rejects.toThrow(/cancelled/);
    await assertPackingInvariants();
  });
});

describe("completing a package", () => {
  it("completes a package with contents: immutable afterwards (no add, edit, remove, update, cancel, complete)", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    const added = await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 4 });
    const itemId = added.session.packages[0].items[0].id;
    const done = await completePackage(ctx, { packageId: p.packageId });
    expect(done.session.packages[0]).toMatchObject({ status: "COMPLETED", totalQuantity: 4 });
    expect(done.session.packages[0].completedAt).toBeTruthy();
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } })).completedByUserId).toBe(ctx.userId);

    await expect(addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 1 })).rejects.toThrow(/completed/);
    await expect(setPackageItemQuantity(ctx, { itemId, quantity: 2 })).rejects.toThrow(/completed/);
    await expect(removePackageItem(ctx, { itemId })).rejects.toThrow(/completed/);
    await expect(updatePackage(ctx, { packageId: p.packageId, weightG: 5 })).rejects.toThrow(/completed/);
    await expect(cancelPackage(ctx, { packageId: p.packageId })).rejects.toThrow(/completed/);
    await expect(completePackage(ctx, { packageId: p.packageId })).rejects.toThrow(/completed/);
    expect((await getPackingSession(ctx, sessionId)).packages[0]).toMatchObject({ status: "COMPLETED", totalQuantity: 4 });
    expect((await line(ctx, sessionId, "SKU-A")).packedQty).toBe(4);
    await assertPackingInvariants();
  });

  it("refuses to complete an empty package", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    await expect(completePackage(ctx, { packageId: p.packageId })).rejects.toThrow(/empty/);
    expect((await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } })).status).toBe("OPEN");
  });

  it("the database requires completedAt for a COMPLETED package and cancelledAt for a CANCELLED one", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    await expect(prisma.package.update({ where: { id: p.packageId }, data: { status: "COMPLETED" } })).rejects.toBeTruthy();
    await expect(prisma.package.update({ where: { id: p.packageId }, data: { status: "CANCELLED" } })).rejects.toBeTruthy();
    await prisma.package.update({ where: { id: p.packageId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  });
});

describe("order lifecycle through packing", () => {
  it("PICKED -> PACKING at start, back to PICKED on cancel, PACKED only when every picked unit is packed", async () => {
    const { ctx, order, sessionId } = await setup();
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    const p = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 10 });
    await completePackage(ctx, { packageId: p.packageId });
    // a package exists and is complete, yet the order is NOT packed: SKU-B (4) is still unpacked
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    const { completePacking } = await import("..");
    await expect(completePacking(ctx, { sessionId })).rejects.toBeInstanceOf(InvalidStateError);
    expect((await getOrder(ctx, order.id)).status).toBe("PACKING");
    const p2 = await createPackage(ctx, { sessionId });
    await addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-B", quantity: 4 });
    await completePackage(ctx, { packageId: p2.packageId });
    expect((await completePacking(ctx, { sessionId })).session.orderStatus).toBe("PACKED");
  });
});

describe("audit trail", () => {
  it("records every packing action in an append-only event log", async () => {
    const { ctx, sessionId } = await setup();
    const p = await createPackage(ctx, { sessionId });
    const added = await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 3 });
    await setPackageItemQuantity(ctx, { itemId: added.session.packages[0].items[0].id, quantity: 5 });
    await completePackage(ctx, { packageId: p.packageId });
    const events = await prisma.packingEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["SESSION_STARTED", "PACKAGE_CREATED", "ITEM_ADDED", "ITEM_CHANGED", "PACKAGE_COMPLETED"]);
    expect(events[2]).toMatchObject({ quantityDelta: 3, quantityAfter: 3, actorUserId: ctx.userId });
    expect(events[3]).toMatchObject({ quantityDelta: 2, quantityAfter: 5 });
    await expect(prisma.packingEvent.updateMany({ data: { detail: "tampered" } })).rejects.toBeTruthy();
    await expect(prisma.packingEvent.deleteMany({})).rejects.toBeTruthy();
    expect(await prisma.packingEvent.count()).toBe(5);
  });
});

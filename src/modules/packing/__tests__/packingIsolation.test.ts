// Cross-organization access: foreign orders, packing sessions, packages, package items and products
// must be neither visible nor mutable, at the service layer AND at the database layer.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPackingInvariants, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { NotFoundError, WrongProductError } from "@/lib/errors";
import {
  addPackageItem,
  cancelPackage,
  cancelPacking,
  completePackage,
  completePacking,
  createPackage,
  getPackingSession,
  listPackableOrders,
  listSessionsOfOrder,
  removePackageItem,
  setPackageItemQuantity,
  startPacking,
  updatePackage,
} from "..";

beforeEach(resetDatabase);

async function twoTenants() {
  const a = await tenantWithWarehouse("ia", { bays: 2, levels: 1 });
  const b = await tenantWithWarehouse("ib", { bays: 2, levels: 1 });
  const pa = await makeProduct(a.ctx, "SKU-A");
  const pb = await makeProduct(b.ctx, "SKU-B");
  await stockAt(a.ctx, pa.id, a.byCode("R01-L01-B01-P01").id, 20);
  await stockAt(b.ctx, pb.id, b.byCode("R01-L01-B01-P01").id, 20);
  const orderA = await makeOrder(a.ctx, [{ productId: pa.id, quantity: 6 }]);
  const orderB = await makeOrder(b.ctx, [{ productId: pb.id, quantity: 6 }]);
  await pickOrder(a.ctx, orderA.id);
  await pickOrder(b.ctx, orderB.id);
  const sa = await startPacking(a.ctx, { orderId: orderA.id });
  const pkgA = await createPackage(a.ctx, { sessionId: sa.session.id });
  const added = await addPackageItem(a.ctx, { packageId: pkgA.packageId, productCode: "SKU-A", quantity: 2 });
  return { a, b, pa, pb, orderA, orderB, sessionA: sa.session.id, packageA: pkgA.packageId!, itemA: added.session.packages[0].items[0].id };
}

describe("service layer", () => {
  it("foreign orders: invisible in the queue, cannot start packing", async () => {
    const { b, orderA, orderB } = await twoTenants();
    expect((await listPackableOrders(b.ctx)).map((o) => o.orderId)).toEqual([orderB.id]);
    await expect(startPacking(b.ctx, { orderId: orderA.id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(listSessionsOfOrder(b.ctx, orderA.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("foreign packing sessions: not readable, not changeable", async () => {
    const { a, b, sessionA } = await twoTenants();
    await expect(getPackingSession(b.ctx, sessionA)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPackage(b.ctx, { sessionId: sessionA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completePacking(b.ctx, { sessionId: sessionA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelPacking(b.ctx, { sessionId: sessionA })).rejects.toBeInstanceOf(NotFoundError);
    expect((await getPackingSession(a.ctx, sessionA)).status).toBe("OPEN");
  });

  it("foreign packages and package items: not readable, not changeable", async () => {
    const { a, b, packageA, itemA, sessionA } = await twoTenants();
    await expect(addPackageItem(b.ctx, { packageId: packageA, productCode: "SKU-B", quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updatePackage(b.ctx, { packageId: packageA, weightG: 5 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(completePackage(b.ctx, { packageId: packageA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancelPackage(b.ctx, { packageId: packageA })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setPackageItemQuantity(b.ctx, { itemId: itemA, quantity: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(removePackageItem(b.ctx, { itemId: itemA })).rejects.toBeInstanceOf(NotFoundError);
    const s = await getPackingSession(a.ctx, sessionA);
    expect(s.packages[0]).toMatchObject({ status: "OPEN", totalQuantity: 2 });
    await assertPackingInvariants();
  });

  it("foreign products cannot be packed, and a product code resolves only within the caller's organization", async () => {
    const { a, b, orderB } = await twoTenants();
    const sb = await startPacking(b.ctx, { orderId: orderB.id });
    const pkgB = await createPackage(b.ctx, { sessionId: sb.session.id });
    // org A's SKU is unknown to org B
    await expect(addPackageItem(b.ctx, { packageId: pkgB.packageId, productCode: "SKU-A", quantity: 1 })).rejects.toBeInstanceOf(WrongProductError);
    // and B's own SKU works for B only
    await expect(addPackageItem(b.ctx, { packageId: pkgB.packageId, productCode: "SKU-B", quantity: 1 })).resolves.toBeTruthy();
    const pkgA = await prisma.package.findFirstOrThrow({ where: { organizationId: a.org.organization.id } });
    await expect(addPackageItem(a.ctx, { packageId: pkgA.id, productCode: "SKU-B", quantity: 1 })).rejects.toBeInstanceOf(WrongProductError);
    await assertPackingInvariants();
  });
});

describe("database layer: composite foreign keys", () => {
  it("a session, package or item cannot reference another organization's order, session, package or order line", async () => {
    const { a, b, orderA, orderB, sessionA, packageA, pa } = await twoTenants();
    const orgA = a.org.organization.id;
    const orgB = b.org.organization.id;
    const lineA = await prisma.orderLine.findFirstOrThrow({ where: { orderId: orderA.id } });
    const lineB = await prisma.orderLine.findFirstOrThrow({ where: { orderId: orderB.id } });
    const productB = await prisma.product.findFirstOrThrow({ where: { organizationId: orgB } });
    const emptyPackageA = (await createPackage(a.ctx, { sessionId: sessionA })).packageId!; // no item for line A yet (avoids a unique conflict hiding the FK check)

    // a session of org A pointing at org B's order
    await expect(prisma.packingSession.create({ data: { organizationId: orgA, orderId: orderB.id } })).rejects.toMatchObject({ code: "P2003" });
    // a package of org A in org B's session / for org B's order
    await expect(prisma.package.create({ data: { organizationId: orgB, sessionId: sessionA, orderId: orderA.id, packageNumber: 50 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.package.create({ data: { organizationId: orgA, sessionId: sessionA, orderId: orderB.id, packageNumber: 51 } })).rejects.toMatchObject({ code: "P2003" });
    // an item in org A's package with org B's order line or product
    await expect(prisma.packageItem.create({ data: { organizationId: orgA, packageId: packageA, orderId: orderA.id, orderLineId: lineB.id, productId: productB.id, quantity: 1 } })).rejects.toMatchObject({ code: "P2003" });
    await expect(prisma.packageItem.create({ data: { organizationId: orgB, packageId: emptyPackageA, orderId: orderA.id, orderLineId: lineA.id, productId: pa.id, quantity: 1 } })).rejects.toMatchObject({ code: "P2003" });
    // an audit event cannot hang on another organization's session
    await expect(prisma.packingEvent.create({ data: { organizationId: orgB, sessionId: sessionA, type: "SESSION_STARTED" } })).rejects.toMatchObject({ code: "P2003" });
  });
});

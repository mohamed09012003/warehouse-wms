// Packing must NEVER change inventory: not onHand, not reserved, not movements, not reservations.
// Picking already consumed the stock; packing only records picked quantity -> package contents.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { assertPackingInvariants, assertPickingInvariants, inventorySnapshot, makeOrder, makeProduct, pickOrder, stockAt, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { AppError } from "@/lib/errors";
import { addPackageItem, cancelPackage, cancelPacking, completePackage, completePacking, createPackage, removePackageItem, setPackageItemQuantity, startPacking } from "..";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("is", { bays: 3, levels: 1 });
  const prod = await makeProduct(t.ctx, "SKU-A");
  const P1 = t.byCode("R01-L01-B01-P01");
  await stockAt(t.ctx, prod.id, P1.id, 30);
  const order = await makeOrder(t.ctx, [{ productId: prod.id, quantity: 12 }]);
  await pickOrder(t.ctx, order.id);
  return { ...t, prod, P1, order };
}

describe("packing leaves inventory untouched", () => {
  it("a complete packing flow (start, packages, items, corrections, completion) changes no balance, movement, operation or reservation", async () => {
    const { ctx, prod, P1, order } = await setup();
    const before = await inventorySnapshot();
    const balanceBefore = await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: P1.id, productId: prod.id } });
    const movementsBefore = await prisma.inventoryMovement.count();

    const s = await startPacking(ctx, { orderId: order.id });
    const p1 = await createPackage(ctx, { sessionId: s.session.id, weightG: 3000, lengthMm: 300, widthMm: 200, heightMm: 100 });
    const added = await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 9 });
    expect(await inventorySnapshot()).toBe(before); // mid-flow
    await setPackageItemQuantity(ctx, { itemId: added.session.packages[0].items[0].id, quantity: 5 });
    await removePackageItem(ctx, { itemId: added.session.packages[0].items[0].id });
    await addPackageItem(ctx, { packageId: p1.packageId, productCode: "SKU-A", quantity: 8 });
    await completePackage(ctx, { packageId: p1.packageId });
    const p2 = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: p2.packageId, productCode: "SKU-A", quantity: 4 });
    await completePackage(ctx, { packageId: p2.packageId });
    await completePacking(ctx, { sessionId: s.session.id });

    expect(await inventorySnapshot()).toBe(before);
    const balanceAfter = await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: P1.id, productId: prod.id } });
    expect([balanceAfter.onHand, balanceAfter.reserved, balanceAfter.version]).toEqual([balanceBefore.onHand, balanceBefore.reserved, balanceBefore.version]);
    expect(balanceAfter.onHand).toBe(18); // 30 received - 12 picked, as left by picking
    expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
    expect(await prisma.inventoryMovement.count({ where: { type: { notIn: ["RECEIVE", "RESERVE", "PICK"] } } })).toBe(0); // no PACK-like or corrective entries
    await assertPackingInvariants();
    await assertPickingInvariants();
  });

  it("a cancelled packing session changes no inventory and does not undo picking", async () => {
    const { ctx, order } = await setup();
    const before = await inventorySnapshot();
    const lineBefore = await prisma.orderLine.findFirstOrThrow();
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 7 });
    await cancelPackage(ctx, { packageId: p.packageId });
    await cancelPacking(ctx, { sessionId: s.session.id });
    expect(await inventorySnapshot()).toBe(before);
    const lineAfter = await prisma.orderLine.findFirstOrThrow();
    expect([lineAfter.pickedQty, lineAfter.allocatedQty, lineAfter.requestedQty]).toEqual([lineBefore.pickedQty, lineBefore.allocatedQty, lineBefore.requestedQty]);
    expect(await prisma.pickTask.count({ where: { status: "COMPLETED" } })).toBe(1); // picking history intact
    await assertPickingInvariants();
  });

  it("failed packing operations (over-packing, wrong product, immutable package) change no inventory", async () => {
    const { ctx, order } = await setup();
    const before = await inventorySnapshot();
    const s = await startPacking(ctx, { orderId: order.id });
    const p = await createPackage(ctx, { sessionId: s.session.id });
    await addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 12 });
    await completePackage(ctx, { packageId: p.packageId });
    for (const attempt of [
      () => addPackageItem(ctx, { packageId: p.packageId, productCode: "SKU-A", quantity: 1 }),
      () => addPackageItem(ctx, { packageId: p.packageId, productCode: "NOPE", quantity: 1 }),
      () => completePackage(ctx, { packageId: p.packageId }),
      () => cancelPackage(ctx, { packageId: p.packageId }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(AppError);
    }
    expect(await inventorySnapshot()).toBe(before);
  });

  it("packing code does not reference inventory tables or services at all", async () => {
    // A structural guard: the packing module must not import the inventory module or touch its tables.
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = "src/modules/packing";
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        if (f.isDirectory()) {
          if (f.name !== "__tests__") walk(join(d, f.name));
        } else if (f.name.endsWith(".ts")) files.push(join(d, f.name));
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const code = readFileSync(file, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
      expect(code, file).not.toMatch(/@\/modules\/inventory|inventoryBalance|inventoryMovement|inventoryOperation|"InventoryBalance"|"InventoryMovement"|"Reservation"|reservationLine/i);
    }
  });
});

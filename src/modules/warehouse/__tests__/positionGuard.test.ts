// Phase 3 rule: positions that hold stock or reservations are never destroyed by layout changes.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../../tests/support/db";
import { layoutPayload, makeProduct, tenantWithWarehouse } from "../../../../tests/support/fixtures";
import { PositionInUseError } from "@/lib/errors";
import { createReservation, moveStock, receiveStock } from "@/modules/inventory";
import { getLayout, saveLayout } from "..";
import { suggestBays, suggestLevels } from "../domain/structure";

beforeEach(resetDatabase);

async function setup() {
  const t = await tenantWithWarehouse("g", { levels: 2, bays: 3, positionsPerBay: 1 }); // 6 positions
  const product = await makeProduct(t.ctx);
  const layout = () => getLayout(t.ctx, t.warehouseId);
  const save = async (patch: (rack: Awaited<ReturnType<typeof layout>>["racks"][number]) => object) => {
    const current = await layout();
    return saveLayout(t.ctx, t.warehouseId, layoutPayload(current, { racks: current.racks.map((r) => ({ ...r, ...patch(r) })) }));
  };
  return { ...t, product, layout, save };
}

describe("positions with stock are protected", () => {
  it("rejects removing a bay that contains stock; nothing changes", async () => {
    const { ctx, product, byCode, save, layout } = await setup();
    const p = byCode("R01-L01-B03-P01"); // last bay
    await receiveStock(ctx, { productId: product.id, positionId: p.id, quantity: 5 });

    const before = await layout();
    await expect(save((r) => ({ lengthMm: 4000, bays: r.bays.slice(0, 2) }))).rejects.toBeInstanceOf(PositionInUseError);

    const after = await layout();
    expect(after.warehouse.layoutVersion).toBe(before.warehouse.layoutVersion); // rolled back, version not bumped
    expect(await prisma.position.count()).toBe(6);
    expect(await prisma.bay.count()).toBe(3);
    expect((await prisma.inventoryBalance.findFirstOrThrow()).onHand).toBe(5);
  });

  it("names the occupied positions in the error", async () => {
    const { ctx, product, byCode, save } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: byCode("R01-L02-B01-P01").id, quantity: 1 });
    const err = await save((r) => ({ levels: r.levels.slice(0, 1) })).catch((e) => e);
    expect(err).toBeInstanceOf(PositionInUseError);
    expect(err.message).toContain("R01-L02-B01-P01");
    expect(err.details).toEqual({ positions: ["R01-L02-B01-P01"] });
  });

  it("rejects removing a level or reducing positions-per-bay when an affected position holds stock", async () => {
    const { ctx, product, save } = await setup();
    // 2 positions per bay first (empty positions may be added freely)
    await save((r) => ({ bays: r.bays.map((b) => ({ ...b, positionCount: 2 })) }));
    expect(await prisma.position.count()).toBe(12);
    const second = await prisma.position.findFirstOrThrow({ where: { code: "R01-L01-B01-P02" } });
    await receiveStock(ctx, { productId: product.id, positionId: second.id, quantity: 2 });
    await expect(save((r) => ({ bays: r.bays.map((b) => ({ ...b, positionCount: 1 })) }))).rejects.toBeInstanceOf(PositionInUseError);
    expect(await prisma.position.count()).toBe(12);
  });

  it("rejects deleting a rack that holds stock", async () => {
    const { ctx, product, byCode, layout } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: byCode("R01-L01-B01-P01").id, quantity: 1 });
    const current = await layout();
    await expect(saveLayout(ctx, current.warehouse.id, layoutPayload(current, { racks: [] }))).rejects.toBeInstanceOf(PositionInUseError);
    expect(await prisma.rack.count()).toBe(1);
    expect(await prisma.position.count()).toBe(6);
  });

  it("rejects removing a position that only has RESERVED stock protection (reserved > 0)", async () => {
    const { ctx, product, byCode, save } = await setup();
    const p = byCode("R01-L01-B03-P01");
    await receiveStock(ctx, { productId: product.id, positionId: p.id, quantity: 4 });
    await createReservation(ctx, { lines: [{ productId: product.id, positionId: p.id, quantity: 4 }] });
    await expect(save((r) => ({ lengthMm: 4000, bays: r.bays.slice(0, 2) }))).rejects.toBeInstanceOf(PositionInUseError);
    expect(await prisma.position.count()).toBe(6);
    expect((await prisma.inventoryBalance.findFirstOrThrow()).reserved).toBe(4);
  });

  it("the database itself refuses to delete a position that has a balance row", async () => {
    const { ctx, product, byCode } = await setup();
    const p = byCode("R01-L01-B01-P01");
    await receiveStock(ctx, { productId: product.id, positionId: p.id, quantity: 1 });
    await expect(prisma.position.delete({ where: { id: p.id } })).rejects.toMatchObject({ code: "P2003" });
    // and cascade deletes from rack/level/bay cannot sweep it away either
    await expect(prisma.rack.deleteMany({})).rejects.toBeTruthy();
    expect(await prisma.position.count()).toBe(6);
  });
});

describe("layout changes that are still allowed", () => {
  it("moving, rotating and resizing a rack with stock keeps positions and stock", async () => {
    const { ctx, product, byCode, save } = await setup();
    const p = byCode("R01-L01-B01-P01");
    await receiveStock(ctx, { productId: product.id, positionId: p.id, quantity: 9 });
    await save(() => ({ xMm: 20000, yMm: 10000, rotationDeg: 90, depthMm: 1200 }));
    expect(await prisma.position.count()).toBe(6);
    expect((await prisma.inventoryBalance.findFirstOrThrow()).onHand).toBe(9);
  });

  it("renaming the rack regenerates codes; stock follows the position (id), movements keep the old code snapshot", async () => {
    const { ctx, product, byCode, save } = await setup();
    const p = byCode("R01-L01-B01-P01");
    await receiveStock(ctx, { productId: product.id, positionId: p.id, quantity: 3 });
    await save(() => ({ code: "Z9" }));
    const moved = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
    expect(moved.code).toBe("Z9-L01-B01-P01");
    expect((await prisma.inventoryBalance.findFirstOrThrow()).positionId).toBe(p.id);
    expect((await prisma.inventoryMovement.findFirstOrThrow()).positionCode).toBe("R01-L01-B01-P01");
  });

  it("removing EMPTY positions still works, including ones whose balance rows are 0/0", async () => {
    const { ctx, product, byCode, save } = await setup();
    const last = byCode("R01-L01-B03-P01");
    const other = byCode("R01-L01-B01-P01");
    await receiveStock(ctx, { productId: product.id, positionId: last.id, quantity: 4 });
    await moveStock(ctx, { productId: product.id, fromPositionId: last.id, toPositionId: other.id, quantity: 4 }); // leaves a 0/0 balance row at `last`
    expect(await prisma.inventoryBalance.count({ where: { positionId: last.id, onHand: 0, reserved: 0 } })).toBe(1);

    await save((r) => ({ lengthMm: 4000, bays: r.bays.slice(0, 2) }));
    expect(await prisma.position.count()).toBe(4);
    expect(await prisma.inventoryBalance.count({ where: { positionId: last.id } })).toBe(0); // empty row cleaned
    expect((await prisma.inventoryBalance.findFirstOrThrow({ where: { positionId: other.id } })).onHand).toBe(4);
    // history survives with its code snapshot
    expect(await prisma.inventoryMovement.count({ where: { positionCode: "R01-L01-B03-P01" } })).toBe(2);
  });

  it("adding positions (more levels/bays) with stock present is fine", async () => {
    const { ctx, product, byCode, save } = await setup();
    await receiveStock(ctx, { productId: product.id, positionId: byCode("R01-L01-B01-P01").id, quantity: 1 });
    await save(() => ({ lengthMm: 8000, levels: suggestLevels(6000, 3, { baseElevationMm: 150, beamMm: 100 }), bays: suggestBays(8000, 2000).bays }));
    expect(await prisma.position.count()).toBe(3 * 4);
  });
});

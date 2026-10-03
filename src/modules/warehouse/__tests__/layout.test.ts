import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeOrg, prisma, resetDatabase } from "../../../../tests/support/db";
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { createUser } from "@/modules/identity";
import { createOrganizationWithOwner, resolveTenantContext, type TenantContext } from "@/modules/tenancy";
import {
  createPalletType,
  createWarehouse,
  getLayout,
  getRackElevation,
  listPalletTypes,
  listWarehouses,
  saveLayout,
  type LayoutDto,
} from "..";
import { formatLocationCode } from "../domain/locationCode";
import { suggestBays, suggestLevels, totalPositions } from "../domain/structure";

beforeEach(resetDatabase);

async function newTenant(label = "t") {
  const org = await createOrganizationWithOwner(fakeOrg(label));
  const ctx = await resolveTenantContext(org.ownerUserId, org.organization.slug);
  return { org, ctx };
}

function rack(code: string, dims: { lengthMm: number; depthMm: number; heightMm: number }, levelCount: number, bayWidthMm: number, extra = {}) {
  return {
    id: randomUUID(),
    code,
    name: null,
    xMm: 2000,
    yMm: 2000,
    rotationDeg: 0,
    ...dims,
    levels: suggestLevels(dims.heightMm, levelCount, { baseElevationMm: 150, beamMm: 100 }),
    bays: suggestBays(dims.lengthMm, bayWidthMm).bays,
    ...extra,
  };
}

function payload(layout: LayoutDto, patch: Record<string, unknown> = {}) {
  return {
    version: layout.warehouse.layoutVersion,
    warehouse: { name: layout.warehouse.name, widthMm: layout.warehouse.widthMm, lengthMm: layout.warehouse.lengthMm },
    objects: layout.objects,
    racks: layout.racks,
    ...patch,
  };
}

async function setup() {
  const t = await newTenant();
  const wh = await createWarehouse(t.ctx, { code: "main", name: "Main", widthMm: 40000, lengthMm: 30000 });
  const layout = await getLayout(t.ctx, wh.id);
  return { ...t, wh, layout };
}

describe("warehouse creation", () => {
  it("creates a warehouse with numeric mm dimensions and normalizes the code", async () => {
    const { ctx, wh } = await setup();
    expect(wh).toMatchObject({ code: "MAIN", widthMm: 40000, lengthMm: 30000, layoutVersion: 1 });
    expect((await listWarehouses(ctx)).map((w) => w.code)).toEqual(["MAIN"]);
  });

  it("rejects invalid dimensions and duplicate codes", async () => {
    const { ctx } = await setup();
    await expect(createWarehouse(ctx, { code: "X", name: "x", widthMm: 0, lengthMm: 1000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createWarehouse(ctx, { code: "X", name: "x", widthMm: "12m", lengthMm: 1000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(createWarehouse(ctx, { code: "main", name: "dup", widthMm: 1000, lengthMm: 1000 })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("saving and reloading a layout", () => {
  it("persists several racks with different dimensions and generates positions from the configuration", async () => {
    const { ctx, wh, layout } = await setup();
    const r1 = rack("R01", { lengthMm: 12000, depthMm: 1100, heightMm: 6000 }, 4, 2000); // 6 bays x 4 levels
    const r2 = rack("R02", { lengthMm: 12000, depthMm: 1100, heightMm: 6000 }, 3, 1200); // 10 bays x 3 levels
    const r3 = rack("R03", { lengthMm: 3600, depthMm: 900, heightMm: 2400 }, 2, 1200, { rotationDeg: 90, xMm: 9000 }); // 3 bays x 2

    const saved = await saveLayout(ctx, wh.id, payload(layout, { racks: [r1, r2, r3] }));
    expect(saved.warehouse.layoutVersion).toBe(2);
    expect(saved.racks.map((r) => r.code)).toEqual(["R01", "R02", "R03"]);

    const expected = { R01: 6 * 4, R02: 10 * 3, R03: 3 * 2 };
    for (const r of saved.racks) {
      expect(await prisma.position.count({ where: { rackId: r.id } })).toBe(expected[r.code as keyof typeof expected]);
      expect(totalPositions({ levels: r.levels, bays: r.bays })).toBe(expected[r.code as keyof typeof expected]);
    }

    // Reload from the database: geometry and structure are identical to what was saved.
    const reloaded = await getLayout(ctx, wh.id);
    expect(reloaded).toEqual(saved);
    const r3Reloaded = reloaded.racks.find((r) => r.code === "R03")!;
    expect(r3Reloaded).toMatchObject({ rotationDeg: 90, xMm: 9000, lengthMm: 3600, depthMm: 900, heightMm: 2400 });
  });

  it("stores the structured hierarchy and generates the same code from it", async () => {
    const { ctx, wh, layout } = await setup();
    const r1 = rack("R01", { lengthMm: 12000, depthMm: 1100, heightMm: 6000 }, 4, 2000, {
      bays: suggestBays(12000, 2000, { positionCount: 2 }).bays,
    });
    await saveLayout(ctx, wh.id, payload(layout, { racks: [r1] }));

    const el = await getRackElevation(ctx, wh.id, r1.id);
    expect(el.levels.map((l) => l.levelIndex)).toEqual([0, 1, 2, 3]);
    expect(el.bays).toHaveLength(6);
    expect(el.positions).toHaveLength(4 * 6 * 2);
    for (const p of el.positions) {
      expect(p.code).toBe(formatLocationCode({ rackCode: "R01", ...p }));
    }
    expect(el.positions.find((p) => p.levelIndex === 0 && p.bayIndex === 3 && p.positionIndex === 2)?.code).toBe("R01-L01-B03-P02");

    const row = await prisma.position.findFirstOrThrow({
      where: { code: "R01-L01-B03-P02" },
      include: { level: true, bay: true, rack: true },
    });
    expect([row.rack.code, row.level.levelIndex, row.bay.bayIndex, row.positionIndex]).toEqual(["R01", 0, 3, 2]);
  });

  it("applies objects: add, update and delete", async () => {
    const { ctx, wh, layout } = await setup();
    const wall = { id: randomUUID(), type: "WALL" as const, label: null, xMm: 1000, yMm: 500, widthMm: 8000, depthMm: 200, rotationDeg: 0 };
    const door = { id: randomUUID(), type: "DOOR" as const, label: "Dock door", xMm: 3000, yMm: 500, widthMm: 1200, depthMm: 200, rotationDeg: 0 };
    const types = ["AISLE", "LOADING_AREA", "PACKING_AREA", "WORK_AREA"] as const;
    const others = types.map((type, i) => ({ id: randomUUID(), type, label: null, xMm: 5000 + i, yMm: 5000, widthMm: 3000, depthMm: 3000, rotationDeg: 0 }));

    let saved = await saveLayout(ctx, wh.id, payload(layout, { objects: [wall, door, ...others] }));
    expect(saved.objects).toHaveLength(6);

    saved = await saveLayout(ctx, wh.id, payload(saved, { objects: [{ ...wall, xMm: 4000, rotationDeg: 270 }, ...others.slice(0, 1)] }));
    expect(saved.objects).toHaveLength(2);
    expect(saved.objects.find((o) => o.id === wall.id)).toMatchObject({ xMm: 4000, rotationDeg: 270 });
  });

  it("moving, rotating and resizing a rack keeps its positions (same ids)", async () => {
    const { ctx, wh, layout } = await setup();
    const r1 = rack("R01", { lengthMm: 6000, depthMm: 1100, heightMm: 4500 }, 3, 2000);
    let saved = await saveLayout(ctx, wh.id, payload(layout, { racks: [r1] }));
    const before = (await prisma.position.findMany({ where: { rackId: r1.id } })).map((p) => p.id).sort();

    saved = await saveLayout(ctx, wh.id, payload(saved, { racks: [{ ...saved.racks[0], xMm: 15000, yMm: 8000, rotationDeg: 180, depthMm: 1200 }] }));
    expect(saved.racks[0]).toMatchObject({ xMm: 15000, yMm: 8000, rotationDeg: 180, depthMm: 1200 });
    const after = (await prisma.position.findMany({ where: { rackId: r1.id } })).map((p) => p.id).sort();
    expect(after).toEqual(before);
  });

  it("renaming a rack regenerates location codes from the structure", async () => {
    const { ctx, wh, layout } = await setup();
    const r1 = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    const saved = await saveLayout(ctx, wh.id, payload(layout, { racks: [r1] }));
    await saveLayout(ctx, wh.id, payload(saved, { racks: [{ ...saved.racks[0], code: "A7" }] }));
    const codes = (await prisma.position.findMany({ where: { rackId: r1.id } })).map((p) => p.code).sort();
    expect(codes).toEqual(["A7-L01-B01-P01", "A7-L01-B02-P01", "A7-L02-B01-P01", "A7-L02-B02-P01"]);
  });

  it("changing the structure adds and removes positions; deleting a rack removes everything under it", async () => {
    const { ctx, wh, layout } = await setup();
    const r1 = rack("R01", { lengthMm: 12000, depthMm: 1100, heightMm: 6000 }, 4, 2000);
    let saved = await saveLayout(ctx, wh.id, payload(layout, { racks: [r1] }));
    expect(await prisma.position.count({ where: { rackId: r1.id } })).toBe(24);

    // 2 levels, 3 wider bays, 2 positions each (pallet not constrained: no pallet type set)
    const shrunk = {
      ...saved.racks[0],
      levels: suggestLevels(6000, 2, { baseElevationMm: 150, beamMm: 100 }),
      bays: suggestBays(12000, 4000, { positionCount: 2 }).bays,
    };
    saved = await saveLayout(ctx, wh.id, payload(saved, { racks: [shrunk] }));
    expect(await prisma.position.count({ where: { rackId: r1.id } })).toBe(2 * 3 * 2);
    expect(await prisma.rackLevel.count({ where: { rackId: r1.id } })).toBe(2);
    expect(await prisma.bay.count({ where: { rackId: r1.id } })).toBe(3);

    await saveLayout(ctx, wh.id, payload(saved, { racks: [] }));
    expect(await prisma.rack.count()).toBe(0);
    expect(await prisma.rackLevel.count()).toBe(0);
    expect(await prisma.bay.count()).toBe(0);
    expect(await prisma.position.count()).toBe(0);
  });
});

describe("validation and concurrency", () => {
  it("rejects a physically impossible rack and saves nothing", async () => {
    const { ctx, wh, layout } = await setup();
    const bad = rack("R01", { lengthMm: 12000, depthMm: 1100, heightMm: 6000 }, 4, 2000, { bays: suggestBays(14000, 2000).bays });
    await expect(saveLayout(ctx, wh.id, payload(layout, { racks: [bad] }))).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.rack.count()).toBe(0);
    expect((await getLayout(ctx, wh.id)).warehouse.layoutVersion).toBe(1);
  });

  it("rejects duplicate rack codes in one payload and malformed codes", async () => {
    const { ctx, wh, layout } = await setup();
    const a = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    const b = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    await expect(saveLayout(ctx, wh.id, payload(layout, { racks: [a, b] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(saveLayout(ctx, wh.id, payload(layout, { racks: [{ ...a, code: "R-01" }] }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("detects a stale version (someone else saved first)", async () => {
    const { ctx, wh, layout } = await setup();
    await saveLayout(ctx, wh.id, payload(layout, { racks: [rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000)] }));
    await expect(saveLayout(ctx, wh.id, payload(layout, { racks: [] }))).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.rack.count()).toBe(1);
  });

  it("serializes concurrent saves: exactly one wins", async () => {
    const { ctx, wh, layout } = await setup();
    const attempt = (code: string) =>
      saveLayout(ctx, wh.id, payload(layout, { racks: [rack(code, { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000)] }));
    const results = await Promise.allSettled([attempt("R01"), attempt("R02"), attempt("R03")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.rack.count()).toBe(1);
  });

  it("validates pallet fit using the organization's own pallet types", async () => {
    const { ctx, wh, layout } = await setup();
    const eur = await createPalletType(ctx, { name: "EUR", widthMm: 800, lengthMm: 1200, heightMm: 1200 });
    expect((await listPalletTypes(ctx)).map((p) => p.name)).toEqual(["EUR"]);

    const base = rack("R01", { lengthMm: 5400, depthMm: 1100, heightMm: 6000 }, 3, 2700);
    const ok = { ...base, bays: suggestBays(5400, 2700, { positionCount: 2, palletTypeId: eur.id }).bays };
    const saved = await saveLayout(ctx, wh.id, payload(layout, { racks: [ok] }));
    expect(await prisma.position.count({ where: { palletTypeId: eur.id } })).toBe(2 * 3 * 2);

    const tooMany = { ...ok, bays: suggestBays(5400, 2700, { positionCount: 3, palletTypeId: eur.id }).bays };
    await expect(saveLayout(ctx, wh.id, payload(saved, { racks: [tooMany] }))).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("tenant isolation", () => {
  it("another organization cannot read or modify a warehouse", async () => {
    const a = await setup();
    const b = await newTenant("b");
    await expect(getLayout(b.ctx, a.wh.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveLayout(b.ctx, a.wh.id, payload(a.layout))).rejects.toBeInstanceOf(NotFoundError);
    await expect(getRackElevation(b.ctx, a.wh.id, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    expect(await listWarehouses(b.ctx)).toEqual([]);
  });

  it("cannot attach another organization's pallet type to a bay", async () => {
    const a = await setup();
    const b = await newTenant("b");
    const foreign = await createPalletType(b.ctx, { name: "Theirs", widthMm: 800, lengthMm: 1200 });
    const r = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000, {
      bays: suggestBays(4000, 2000, { palletTypeId: foreign.id }).bays,
    });
    await expect(saveLayout(a.ctx, a.wh.id, payload(a.layout, { racks: [r] }))).rejects.toBeInstanceOf(ValidationError);
    expect(await prisma.rack.count()).toBe(0);
  });

  it("cannot hijack a rack or object id that belongs to another organization", async () => {
    const a = await setup();
    const r = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    await saveLayout(a.ctx, a.wh.id, payload(a.layout, { racks: [r] }));

    const b = await newTenant("b");
    const whB = await createWarehouse(b.ctx, { code: "B1", name: "B", widthMm: 20000, lengthMm: 20000 });
    const layoutB = await getLayout(b.ctx, whB.id);
    await expect(saveLayout(b.ctx, whB.id, payload(layoutB, { racks: [{ ...r, code: "Z1" }] }))).rejects.toBeInstanceOf(ConflictError);
    // org A's rack is untouched
    expect((await prisma.rack.findUniqueOrThrow({ where: { id: r.id } })).code).toBe("R01");
  });

  it("members without warehouse.design can view but not change layouts", async () => {
    const a = await setup();
    const memberRole = await prisma.role.findFirstOrThrow({ where: { organizationId: a.org.organization.id, name: "Member" } });
    const user = await createUser(fakeOrg("m").owner);
    await prisma.membership.create({ data: { organizationId: a.org.organization.id, userId: user.id, roleId: memberRole.id } });
    const memberCtx: TenantContext = await resolveTenantContext(user.id, a.org.organization.slug);

    await expect(getLayout(memberCtx, a.wh.id)).resolves.toBeTruthy();
    await expect(saveLayout(memberCtx, a.wh.id, payload(a.layout))).rejects.toBeInstanceOf(AuthorizationError);
    await expect(createWarehouse(memberCtx, { code: "Q", name: "q", widthMm: 1000, lengthMm: 1000 })).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("database constraints", () => {
  it("rejects non-positive dimensions and hyphenated rack codes at the database level", async () => {
    const { org, wh } = await setup();
    const base = { organizationId: org.organization.id, warehouseId: wh.id, xMm: 0, yMm: 0, rotationDeg: 0, depthMm: 1000, heightMm: 1000 };
    await expect(prisma.rack.create({ data: { ...base, code: "R01", lengthMm: 0 } })).rejects.toBeTruthy();
    await expect(prisma.rack.create({ data: { ...base, code: "R-01", lengthMm: 1000 } })).rejects.toBeTruthy();
  });

  it("a position cannot reference a level or bay from a different rack", async () => {
    const { ctx, org, wh, layout } = await setup();
    const a = rack("R01", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    const b = rack("R02", { lengthMm: 4000, depthMm: 1100, heightMm: 3000 }, 2, 2000);
    await saveLayout(ctx, wh.id, payload(layout, { racks: [a, b] }));
    const levelOfB = await prisma.rackLevel.findFirstOrThrow({ where: { rackId: b.id } });
    const bayOfA = await prisma.bay.findFirstOrThrow({ where: { rackId: a.id } });
    await expect(
      prisma.position.create({
        data: {
          organizationId: org.organization.id,
          warehouseId: wh.id,
          rackId: a.id,
          levelId: levelOfB.id,
          bayId: bayOfA.id,
          positionIndex: 9,
          code: "X",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

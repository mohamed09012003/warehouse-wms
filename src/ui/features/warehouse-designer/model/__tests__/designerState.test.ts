import { describe, expect, it } from "vitest";
import type { LayoutDto } from "@/modules/warehouse/types";
import { designerReducer, initialState, toSavePayload, type DesignerState } from "../designerState";
import { validateDraft } from "../validation";

const layout: LayoutDto = {
  warehouse: { id: "w1", code: "MAIN", name: "Main", widthMm: 40000, lengthMm: 30000, layoutVersion: 3 },
  objects: [],
  racks: [],
};

const start = () => initialState(layout);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function withRack(s: DesignerState, n = 1) {
  return designerReducer(s, { type: "addRack", id: uuid(n), at: { xMm: 5000, yMm: 5000 } });
}

describe("designer state", () => {
  it("starts clean at the loaded version", () => {
    const s = start();
    expect(s.dirty).toBe(false);
    expect(s.version).toBe(3);
  });

  it("adds racks with generated codes and a structure derived from their dimensions", () => {
    let s = withRack(start(), 1);
    s = withRack(s, 2);
    expect(s.racks.map((r) => r.code)).toEqual(["R01", "R02"]);
    expect(s.dirty).toBe(true);
    expect(s.selection).toEqual({ kind: "rack", id: uuid(2) });
    const r = s.racks[0];
    expect(r.bays.length).toBe(Math.floor(r.lengthMm / r.bays[0].widthMm));
    expect(r.levels.length).toBeGreaterThan(0);
  });

  it("never stacks new racks on top of each other", () => {
    let s = start();
    for (let n = 1; n <= 5; n++) s = withRack(s, n);
    const spots = new Set(s.racks.map((r) => `${r.xMm},${r.yMm}`));
    expect(spots.size).toBe(5);
  });

  it("adds every object type", () => {
    let s = start();
    (["WALL", "DOOR", "AISLE", "LOADING_AREA", "PACKING_AREA", "WORK_AREA"] as const).forEach((t, i) => {
      s = designerReducer(s, { type: "addObject", id: uuid(10 + i), objectType: t, at: { xMm: 10000, yMm: 10000 } });
    });
    expect(s.objects.map((o) => o.type)).toEqual(["WALL", "DOOR", "AISLE", "LOADING_AREA", "PACKING_AREA", "WORK_AREA"]);
  });

  it("snaps moves to the grid when enabled and not when disabled", () => {
    let s = withRack(start());
    const sel = { kind: "rack" as const, id: uuid(1) };
    s = designerReducer(s, { type: "moveItem", selection: sel, xMm: 13333, yMm: 9999 });
    const r = s.racks[0];
    expect((r.xMm - r.lengthMm / 2) % 500).toBe(0);
    expect((r.yMm - r.depthMm / 2) % 500).toBe(0);

    s = designerReducer(s, { type: "setGrid", patch: { snap: false } });
    s = designerReducer(s, { type: "moveItem", selection: sel, xMm: 13333, yMm: 9999 });
    expect(s.racks[0]).toMatchObject({ xMm: 13333, yMm: 9999 });
  });

  it("keeps items inside the warehouse canvas", () => {
    let s = withRack(start());
    s = designerReducer(s, { type: "moveItem", selection: { kind: "rack", id: uuid(1) }, xMm: -99999, yMm: 99999 });
    const r = s.racks[0];
    expect(r.xMm - r.lengthMm / 2).toBeGreaterThanOrEqual(0);
    expect(r.yMm + r.depthMm / 2).toBeLessThanOrEqual(30000);
  });

  it("rotates racks and normalizes the angle", () => {
    let s = withRack(start());
    const sel = { kind: "rack" as const, id: uuid(1) };
    s = designerReducer(s, { type: "rotateItem", selection: sel, deltaDeg: 90 });
    expect(s.racks[0].rotationDeg).toBe(90);
    s = designerReducer(s, { type: "rotateItem", selection: sel, deltaDeg: -180 });
    expect(s.racks[0].rotationDeg).toBe(270);
  });

  it("deletes the selected item", () => {
    let s = withRack(start());
    s = designerReducer(s, { type: "deleteSelected" });
    expect(s.racks).toEqual([]);
    expect(s.selection).toBeNull();
  });

  it("selection alone does not make the draft dirty; load resets it and keeps grid settings", () => {
    let s = withRack(start());
    s = designerReducer(s, { type: "setGrid", patch: { sizeMm: 1000 } });
    s = designerReducer(s, { type: "load", layout: { ...layout, warehouse: { ...layout.warehouse, layoutVersion: 4 } } });
    expect(s.dirty).toBe(false);
    expect(s.version).toBe(4);
    expect(s.racks).toEqual([]);
    expect(s.grid.sizeMm).toBe(1000);
    expect(designerReducer(s, { type: "select", selection: null }).dirty).toBe(false);
  });

  it("builds the save payload from the draft", () => {
    const s = designerReducer(withRack(start()), { type: "setWarehouse", patch: { widthMm: 50000 } });
    const p = toSavePayload(s);
    expect(p.version).toBe(3);
    expect(p.warehouse.widthMm).toBe(50000);
    expect(p.racks).toHaveLength(1);
  });
});

describe("draft validation", () => {
  it("is clean for a default rack", () => {
    expect(validateDraft(withRack(start()), []).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags duplicate and malformed codes, and impossible structures", () => {
    let s = withRack(withRack(start(), 1), 2);
    s = designerReducer(s, { type: "updateRack", id: uuid(2), patch: { code: "R01" } });
    expect(validateDraft(s, []).some((i) => /more than once/.test(i.message))).toBe(true);
    s = designerReducer(s, { type: "updateRack", id: uuid(2), patch: { code: "R-2" } });
    expect(validateDraft(s, []).some((i) => /code must be/.test(i.message))).toBe(true);
    s = designerReducer(s, { type: "updateRack", id: uuid(1), patch: { lengthMm: 1000 } }); // bays now longer than the rack
    expect(validateDraft(s, []).some((i) => i.itemId === uuid(1) && /longer than the rack/.test(i.message))).toBe(true);
  });

  it("warns (without blocking) when a rack sticks out of the warehouse", () => {
    let s = withRack(start());
    s = designerReducer(s, { type: "setWarehouse", patch: { widthMm: 2000 } });
    const issues = validateDraft(s, []);
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });
});

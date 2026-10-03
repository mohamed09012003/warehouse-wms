import { describe, expect, it } from "vitest";
import { positionsFit } from "../domain/capacity";
import { boundingBox, clampToCanvas, isInsideCanvas, normalizeDegrees, snapCenter, snapToGrid } from "../domain/geometry";
import { formatLocationCode, levelDisplayNumber, parseLocationCode } from "../domain/locationCode";
import { isValidRackCode, suggestNextRackCode } from "../domain/rackCode";
import { bayOffsets, suggestBays, suggestLevels, totalPositions, validateRackStructure } from "../domain/structure";

describe("location codes", () => {
  it("formats the structured hierarchy (level stored 0-based, displayed 1-based)", () => {
    expect(formatLocationCode({ rackCode: "R01", levelIndex: 0, bayIndex: 3, positionIndex: 2 })).toBe("R01-L01-B03-P02");
    expect(formatLocationCode({ rackCode: "R12", levelIndex: 3, bayIndex: 10, positionIndex: 1 })).toBe("R12-L04-B10-P01");
    expect(levelDisplayNumber(0)).toBe(1);
  });

  it("never truncates wide numbers", () => {
    expect(formatLocationCode({ rackCode: "A", levelIndex: 99, bayIndex: 120, positionIndex: 5 })).toBe("A-L100-B120-P05");
  });

  it("parses back to the same structure and rejects invalid codes", () => {
    const parts = { rackCode: "R01", levelIndex: 2, bayIndex: 7, positionIndex: 4 };
    expect(parseLocationCode(formatLocationCode(parts))).toEqual(parts);
    expect(parseLocationCode("r01-l01-b03-p02")).toEqual({ rackCode: "R01", levelIndex: 0, bayIndex: 3, positionIndex: 2 });
    for (const bad of ["", "R01", "R01-L00-B01-P01", "R01-L01-B00-P01", "R-01-L01-B01-P01", "R01-L01-B01-P01-X"]) {
      expect(parseLocationCode(bad)).toBeNull();
    }
  });
});

describe("rack codes", () => {
  it("validates segment-safe codes (no hyphen)", () => {
    expect(isValidRackCode("R01")).toBe(true);
    expect(isValidRackCode("R-01")).toBe(false);
    expect(isValidRackCode("r01")).toBe(false);
    expect(isValidRackCode("")).toBe(false);
  });

  it("suggests the next free code", () => {
    expect(suggestNextRackCode([])).toBe("R01");
    expect(suggestNextRackCode(["R01", "R02", "R09"])).toBe("R10");
    expect(suggestNextRackCode(["A1", "R03"])).toBe("R04");
  });
});

describe("bay and level suggestions derive from physical dimensions", () => {
  it("12000 mm rack: 2000 mm bays -> 6, 1200 mm bays -> 10", () => {
    expect(suggestBays(12000, 2000).bays).toHaveLength(6);
    expect(suggestBays(12000, 1200).bays).toHaveLength(10);
    expect(suggestBays(12000, 2500)).toMatchObject({ leftoverMm: 2000 });
    expect(suggestBays(12000, 2500).bays).toHaveLength(4);
  });

  it("handles degenerate input", () => {
    expect(suggestBays(1000, 0).bays).toEqual([]);
    expect(suggestBays(500, 2000).bays).toEqual([]);
  });

  it("suggests evenly spaced levels inside the rack height", () => {
    const levels = suggestLevels(6000, 4, { baseElevationMm: 200, beamMm: 100 });
    expect(levels).toHaveLength(4);
    expect(levels[0].elevationMm).toBe(200);
    expect(levels[3].elevationMm + levels[3].clearanceMm).toBeLessThanOrEqual(6000);
  });

  it("computes bay offsets end to end", () => {
    expect(bayOffsets([{ widthMm: 2000, positionCount: 1 }, { widthMm: 1200, positionCount: 1 }, { widthMm: 500, positionCount: 1 }])).toEqual([0, 2000, 3200]);
  });
});

describe("pallet capacity", () => {
  const eur = { widthMm: 800, lengthMm: 1200 };
  it("counts pallets that fit, in the better orientation", () => {
    expect(positionsFit(2700, 1100, eur)).toBe(2); // 2 x 1200 along the beam, 800 deep
    expect(positionsFit(1200, 900, eur)).toBe(1);
    expect(positionsFit(700, 1100, eur)).toBe(0);
  });
  it("accounts for the gap policy", () => {
    expect(positionsFit(2400, 1100, eur, 0)).toBe(2);
    expect(positionsFit(2400, 1100, eur, 100)).toBe(1);
  });
  it("supports deep racking and custom pallet sizes", () => {
    expect(positionsFit(1300, 2500, eur)).toBe(3); // 1200 across x 3 deep (800 each)
    expect(positionsFit(1000, 1000, { widthMm: 1000, lengthMm: 1200 })).toBe(0);
  });
});

describe("rack structure validation", () => {
  const rack = { lengthMm: 12000, depthMm: 1100, heightMm: 6000 };
  const levels = suggestLevels(6000, 4, { baseElevationMm: 150, beamMm: 100 });

  it("accepts a valid structure and counts positions", () => {
    const spec = { levels, bays: suggestBays(12000, 2000, { positionCount: 1 }).bays };
    expect(validateRackStructure(rack, spec)).toEqual([]);
    expect(totalPositions(spec)).toBe(4 * 6);
  });

  it("rejects bays longer than the rack", () => {
    const spec = { levels, bays: suggestBays(14000, 2000).bays };
    expect(validateRackStructure(rack, spec).some((i) => i.path === "bays")).toBe(true);
  });

  it("rejects overlapping levels and levels above the rack", () => {
    const bays = [{ widthMm: 2000, positionCount: 1 }];
    expect(
      validateRackStructure(rack, { bays, levels: [{ elevationMm: 0, clearanceMm: 2000 }, { elevationMm: 1500, clearanceMm: 1000 }] }).length,
    ).toBeGreaterThan(0);
    expect(validateRackStructure(rack, { bays, levels: [{ elevationMm: 5000, clearanceMm: 2000 }] }).length).toBeGreaterThan(0);
  });

  it("rejects position counts that cannot physically fit the pallet type", () => {
    const eur = { widthMm: 800, lengthMm: 1200, heightMm: 1200 };
    const palletTypes = new Map([["p1", eur]]);
    const ok = { levels, bays: [{ widthMm: 2700, positionCount: 2, palletTypeId: "p1" }] };
    expect(validateRackStructure(rack, ok, { palletTypes })).toEqual([]);
    const tooMany = { levels, bays: [{ widthMm: 2700, positionCount: 3, palletTypeId: "p1" }] };
    expect(validateRackStructure(rack, tooMany, { palletTypes }).some((i) => i.path === "bays.0.positionCount")).toBe(true);
    const unknown = { levels, bays: [{ widthMm: 2700, positionCount: 1, palletTypeId: "nope" }] };
    expect(validateRackStructure(rack, unknown, { palletTypes }).length).toBeGreaterThan(0);
  });

  it("rejects pallets taller than a level's clearance", () => {
    const tall = new Map([["p1", { widthMm: 800, lengthMm: 1200, heightMm: 5000 }]]);
    const spec = { levels, bays: [{ widthMm: 2000, positionCount: 1, palletTypeId: "p1" }] };
    expect(validateRackStructure(rack, spec, { palletTypes: tall }).length).toBeGreaterThan(0);
  });
});

describe("geometry", () => {
  it("normalizes degrees", () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
    expect(normalizeDegrees(0)).toBe(0);
  });

  it("swaps bounding box extents at 90 degrees", () => {
    const b = boundingBox({ xMm: 5000, yMm: 5000, widthMm: 4000, depthMm: 1000, rotationDeg: 90 });
    expect(Math.round(b.maxX - b.minX)).toBe(1000);
    expect(Math.round(b.maxY - b.minY)).toBe(4000);
  });

  it("snaps to the grid", () => {
    expect(snapToGrid(1240, 500)).toBe(1000);
    expect(snapToGrid(1260, 500)).toBe(1500);
    expect(snapToGrid(123.4, 0)).toBe(123);
  });

  it("snaps the bounding-box corner (not the center) so edges align at any rotation", () => {
    const box = { xMm: 3333, yMm: 2222, widthMm: 4000, depthMm: 1000, rotationDeg: 0 };
    const s = snapCenter(box, 500);
    expect((s.xMm - 2000) % 500).toBe(0);
    expect((s.yMm - 500) % 500).toBe(0);
    const r = snapCenter({ ...box, rotationDeg: 90 }, 500);
    expect((r.xMm - 500) % 500).toBe(0);
    expect((r.yMm - 2000) % 500).toBe(0);
  });

  it("clamps inside the canvas and detects overflow", () => {
    const box = { xMm: -500, yMm: 99999, widthMm: 2000, depthMm: 1000, rotationDeg: 0 };
    const c = clampToCanvas(box, 20000, 10000);
    expect(c).toEqual({ xMm: 1000, yMm: 9500 });
    expect(isInsideCanvas({ ...box, ...c }, 20000, 10000)).toBe(true);
    expect(isInsideCanvas(box, 20000, 10000)).toBe(false);
  });
});

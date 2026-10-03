// A rack's physical structure as configuration: levels (vertical) and bays (along the length).
// Positions are DERIVED from this (levels x bays x positionCount). Nothing is hard-coded:
// counts, widths and pallet types all come from the spec.
import { positionsFit, type PalletDims } from "./capacity";

export interface LevelSpec {
  /** Height of the load beam above the floor, mm. */
  elevationMm: number;
  /** Usable vertical space for goods on this level, mm. */
  clearanceMm: number;
  maxLoadG?: number | null;
}

export interface BaySpec {
  widthMm: number;
  /** Storage positions per level in this bay. */
  positionCount: number;
  palletTypeId?: string | null;
}

/** Array order is physical order: levels bottom-up (index 0 = ground), bays along the length. */
export interface RackStructureSpec {
  levels: LevelSpec[];
  bays: BaySpec[];
}

export interface RackDims {
  lengthMm: number;
  depthMm: number;
  heightMm: number;
}

export const LIMITS = { maxLevels: 30, maxBays: 200, maxPositionsPerBay: 20, maxPositionsPerRack: 5000 } as const;

export interface StructureIssue {
  path: string;
  message: string;
}

/**
 * Propose bays for a rack: floor(length / bayWidth) equal bays. A suggestion only; the admin
 * confirms, and the result is stored as rows. e.g. 12000/2000 -> 6 bays, 12000/1200 -> 10 bays.
 */
export function suggestBays(
  lengthMm: number,
  bayWidthMm: number,
  defaults: { positionCount?: number; palletTypeId?: string | null } = {},
): { bays: BaySpec[]; leftoverMm: number } {
  if (bayWidthMm <= 0 || lengthMm <= 0) return { bays: [], leftoverMm: Math.max(lengthMm, 0) };
  const count = Math.floor(lengthMm / bayWidthMm);
  return {
    bays: Array.from({ length: count }, () => ({
      widthMm: bayWidthMm,
      positionCount: defaults.positionCount ?? 1,
      palletTypeId: defaults.palletTypeId ?? null,
    })),
    leftoverMm: lengthMm - count * bayWidthMm,
  };
}

/**
 * Propose `levelCount` evenly spaced levels within the rack height.
 * `baseElevationMm` is the first beam height; `beamMm` is the structural thickness lost per level.
 */
export function suggestLevels(
  heightMm: number,
  levelCount: number,
  options: { baseElevationMm?: number; beamMm?: number } = {},
): LevelSpec[] {
  const base = options.baseElevationMm ?? 0;
  const beam = options.beamMm ?? 0;
  if (levelCount < 1 || heightMm <= base) return [];
  const pitch = Math.floor((heightMm - base) / levelCount);
  const clearance = Math.max(pitch - beam, 1);
  return Array.from({ length: levelCount }, (_, i) => ({ elevationMm: base + i * pitch, clearanceMm: clearance }));
}

/** Offsets (mm from the rack's start) of each bay, laid end to end. */
export function bayOffsets(bays: readonly BaySpec[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const b of bays) {
    offsets.push(at);
    at += b.widthMm;
  }
  return offsets;
}

export function totalPositions(spec: RackStructureSpec): number {
  return spec.levels.length * spec.bays.reduce((n, b) => n + b.positionCount, 0);
}

/**
 * Validate a structure against the rack's physical dimensions and (optionally) its pallet types.
 * Returns every problem found; an empty array means valid.
 */
export function validateRackStructure(
  rack: RackDims,
  spec: RackStructureSpec,
  options: { palletTypes?: ReadonlyMap<string, PalletDims>; gapMm?: number } = {},
): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });
  const { levels, bays } = spec;

  if (levels.length < 1) add("levels", "A rack needs at least one level");
  if (levels.length > LIMITS.maxLevels) add("levels", `At most ${LIMITS.maxLevels} levels`);
  if (bays.length < 1) add("bays", "A rack needs at least one bay");
  if (bays.length > LIMITS.maxBays) add("bays", `At most ${LIMITS.maxBays} bays`);

  levels.forEach((lv, i) => {
    if (!Number.isInteger(lv.elevationMm) || lv.elevationMm < 0) add(`levels.${i}.elevationMm`, "Elevation must be a whole number ≥ 0");
    if (!Number.isInteger(lv.clearanceMm) || lv.clearanceMm <= 0) add(`levels.${i}.clearanceMm`, "Clearance must be a whole number > 0");
    const next = levels[i + 1];
    const top = lv.elevationMm + lv.clearanceMm;
    if (next && top > next.elevationMm) add(`levels.${i}`, `Level ${i + 1} overlaps level ${i + 2}`);
    if (!next && top > rack.heightMm) add(`levels.${i}`, `Top level exceeds the rack height (${top} > ${rack.heightMm} mm)`);
  });

  const widthSum = bays.reduce((n, b) => n + b.widthMm, 0);
  if (widthSum > rack.lengthMm) add("bays", `Bays are ${widthSum} mm wide in total, longer than the rack (${rack.lengthMm} mm)`);

  bays.forEach((bay, j) => {
    if (!Number.isInteger(bay.widthMm) || bay.widthMm <= 0) add(`bays.${j}.widthMm`, "Bay width must be a whole number > 0");
    if (!Number.isInteger(bay.positionCount) || bay.positionCount < 1) add(`bays.${j}.positionCount`, "At least one position per bay");
    if (bay.positionCount > LIMITS.maxPositionsPerBay) add(`bays.${j}.positionCount`, `At most ${LIMITS.maxPositionsPerBay} positions per bay`);

    const pallet = bay.palletTypeId ? options.palletTypes?.get(bay.palletTypeId) : undefined;
    if (bay.palletTypeId && options.palletTypes && !pallet) add(`bays.${j}.palletTypeId`, "Unknown pallet type");
    if (pallet) {
      const fit = positionsFit(bay.widthMm, rack.depthMm, pallet, options.gapMm ?? 0);
      if (bay.positionCount > fit) {
        add(`bays.${j}.positionCount`, `Only ${fit} pallet(s) of this type fit in a ${bay.widthMm} × ${rack.depthMm} mm bay`);
      }
      if (pallet.heightMm) {
        levels.forEach((lv, i) => {
          if (pallet.heightMm! > lv.clearanceMm) add(`bays.${j}.palletTypeId`, `Pallet is taller than level ${i + 1} clearance`);
        });
      }
    }
  });

  if (totalPositions(spec) > LIMITS.maxPositionsPerRack) add("bays", `At most ${LIMITS.maxPositionsPerRack} positions per rack`);
  return issues;
}

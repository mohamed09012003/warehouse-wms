// Pure state model of the floor-plan editor: the DRAFT layout plus selection and grid settings.
// No React, no I/O. The reducer applies snapping/clamping through the warehouse domain functions,
// so behaviour is unit-testable and the canvas component stays a thin renderer.
import {
  clampToCanvas,
  findFreeSpot,
  normalizeDegrees,
  snapCenter,
  type Box,
} from "@/modules/warehouse/domain/geometry";
import { suggestNextRackCode } from "@/modules/warehouse/domain/rackCode";
import { suggestBays, suggestLevels } from "@/modules/warehouse/domain/structure";
import type { WarehouseObjectTypeName } from "@/modules/warehouse/schemas";
import type { LayoutDto, LayoutObjectDto, LayoutRackDto } from "@/modules/warehouse/types";
import { OBJECT_PRESETS, RACK_PRESET } from "./presets";

export type Selection = { kind: "object" | "rack"; id: string } | null;

export interface GridSettings {
  sizeMm: number;
  snap: boolean;
  show: boolean;
}

export interface DesignerState {
  warehouse: { id: string; code: string; name: string; widthMm: number; lengthMm: number };
  /** layoutVersion the draft is based on (sent back on save for optimistic concurrency). */
  version: number;
  objects: LayoutObjectDto[];
  racks: LayoutRackDto[];
  selection: Selection;
  grid: GridSettings;
  dirty: boolean;
}

export type DesignerAction =
  | { type: "load"; layout: LayoutDto }
  | { type: "setWarehouse"; patch: Partial<{ name: string; widthMm: number; lengthMm: number }> }
  | { type: "addObject"; id: string; objectType: WarehouseObjectTypeName; at: { xMm: number; yMm: number } }
  | { type: "addRack"; id: string; at: { xMm: number; yMm: number } }
  | { type: "updateObject"; id: string; patch: Partial<Omit<LayoutObjectDto, "id" | "type">> }
  | { type: "updateRack"; id: string; patch: Partial<Omit<LayoutRackDto, "id">> }
  | { type: "moveItem"; selection: NonNullable<Selection>; xMm: number; yMm: number }
  | { type: "rotateItem"; selection: NonNullable<Selection>; deltaDeg: number }
  | { type: "deleteSelected" }
  | { type: "select"; selection: Selection }
  | { type: "setGrid"; patch: Partial<GridSettings> };

export function initialState(layout: LayoutDto): DesignerState {
  return {
    warehouse: {
      id: layout.warehouse.id,
      code: layout.warehouse.code,
      name: layout.warehouse.name,
      widthMm: layout.warehouse.widthMm,
      lengthMm: layout.warehouse.lengthMm,
    },
    version: layout.warehouse.layoutVersion,
    objects: layout.objects,
    racks: layout.racks,
    selection: null,
    grid: { sizeMm: 500, snap: true, show: true },
    dirty: false,
  };
}

function box(item: { xMm: number; yMm: number; rotationDeg: number } & ({ widthMm: number; depthMm: number } | { lengthMm: number; depthMm: number })): Box {
  return {
    xMm: item.xMm,
    yMm: item.yMm,
    widthMm: "lengthMm" in item ? item.lengthMm : item.widthMm,
    depthMm: item.depthMm,
    rotationDeg: item.rotationDeg,
  };
}

/** Where a NEW item goes: snapped, then moved to the nearest free spot so items never stack. */
function placeNew(state: DesignerState, b: Box, others: Box[]): { xMm: number; yMm: number } {
  const snapped = place(state, b);
  const free = findFreeSpot({ ...b, ...snapped }, others, state.warehouse.widthMm, state.warehouse.lengthMm);
  return place(state, { ...b, ...free });
}

/** Snap (if enabled) and keep inside the canvas. */
function place(state: DesignerState, b: Box): { xMm: number; yMm: number } {
  const snapped = state.grid.snap ? snapCenter(b, state.grid.sizeMm) : { xMm: Math.round(b.xMm), yMm: Math.round(b.yMm) };
  return clampToCanvas({ ...b, ...snapped }, state.warehouse.widthMm, state.warehouse.lengthMm);
}

export function newRack(existingCodes: string[], id: string, at: { xMm: number; yMm: number }): LayoutRackDto {
  const p = RACK_PRESET;
  return {
    id,
    code: suggestNextRackCode(existingCodes),
    name: null,
    xMm: at.xMm,
    yMm: at.yMm,
    rotationDeg: 0,
    lengthMm: p.lengthMm,
    depthMm: p.depthMm,
    heightMm: p.heightMm,
    levels: suggestLevels(p.heightMm, p.levelCount, { baseElevationMm: p.baseElevationMm, beamMm: p.beamMm }),
    bays: suggestBays(p.lengthMm, p.bayWidthMm).bays,
  };
}

export function designerReducer(state: DesignerState, action: DesignerAction): DesignerState {
  const touch = (patch: Partial<DesignerState>): DesignerState => ({ ...state, ...patch, dirty: true });

  switch (action.type) {
    case "load":
      return { ...initialState(action.layout), grid: state.grid };

    case "setWarehouse":
      return touch({ warehouse: { ...state.warehouse, ...action.patch } });

    case "addObject": {
      const preset = OBJECT_PRESETS[action.objectType];
      const base: LayoutObjectDto = {
        id: action.id,
        type: action.objectType,
        label: null,
        xMm: action.at.xMm,
        yMm: action.at.yMm,
        widthMm: preset.widthMm,
        depthMm: preset.depthMm,
        rotationDeg: 0,
      };
      const everything = [...state.objects.map((o) => box(o)), ...state.racks.map((r) => box(r))];
      const item = { ...base, ...placeNew(state, box(base), everything) };
      return touch({ objects: [...state.objects, item], selection: { kind: "object", id: item.id } });
    }

    case "addRack": {
      const base = newRack(state.racks.map((r) => r.code), action.id, action.at);
      const rack = { ...base, ...placeNew(state, box(base), [...state.racks.map((r) => box(r)), ...state.objects.map((o) => box(o))]) };
      return touch({ racks: [...state.racks, rack], selection: { kind: "rack", id: rack.id } });
    }

    case "updateObject":
      return touch({ objects: state.objects.map((o) => (o.id === action.id ? { ...o, ...action.patch } : o)) });

    case "updateRack":
      return touch({ racks: state.racks.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r)) });

    case "moveItem": {
      const { kind, id } = action.selection;
      if (kind === "object") {
        const o = state.objects.find((x) => x.id === id);
        if (!o) return state;
        const pos = place(state, box({ ...o, xMm: action.xMm, yMm: action.yMm }));
        if (pos.xMm === o.xMm && pos.yMm === o.yMm) return state;
        return touch({ objects: state.objects.map((x) => (x.id === id ? { ...x, ...pos } : x)) });
      }
      const r = state.racks.find((x) => x.id === id);
      if (!r) return state;
      const pos = place(state, box({ ...r, xMm: action.xMm, yMm: action.yMm }));
      if (pos.xMm === r.xMm && pos.yMm === r.yMm) return state;
      return touch({ racks: state.racks.map((x) => (x.id === id ? { ...x, ...pos } : x)) });
    }

    case "rotateItem": {
      const { kind, id } = action.selection;
      const rotate = <T extends { id: string; xMm: number; yMm: number; rotationDeg: number }>(item: T): T => {
        const rotationDeg = normalizeDegrees(item.rotationDeg + action.deltaDeg);
        const b = box({ ...(item as unknown as Parameters<typeof box>[0]), rotationDeg });
        return { ...item, rotationDeg, ...clampToCanvas(b, state.warehouse.widthMm, state.warehouse.lengthMm) };
      };
      return kind === "object"
        ? touch({ objects: state.objects.map((o) => (o.id === id ? rotate(o) : o)) })
        : touch({ racks: state.racks.map((r) => (r.id === id ? rotate(r) : r)) });
    }

    case "deleteSelected": {
      const sel = state.selection;
      if (!sel) return state;
      return touch({
        objects: sel.kind === "object" ? state.objects.filter((o) => o.id !== sel.id) : state.objects,
        racks: sel.kind === "rack" ? state.racks.filter((r) => r.id !== sel.id) : state.racks,
        selection: null,
      });
    }

    case "select":
      return { ...state, selection: action.selection };

    case "setGrid":
      return { ...state, grid: { ...state.grid, ...action.patch } };
  }
}

/** The body for PUT /layout, built from the draft. */
export function toSavePayload(state: DesignerState) {
  return {
    version: state.version,
    warehouse: { name: state.warehouse.name, widthMm: state.warehouse.widthMm, lengthMm: state.warehouse.lengthMm },
    objects: state.objects,
    racks: state.racks,
  };
}

// Editor defaults for NEW items (starting sizes only). They are not constraints: every value is
// editable in the inspector and is stored as ordinary data.
import type { WarehouseObjectTypeName } from "@/modules/warehouse/schemas";

export interface ObjectPreset {
  label: string;
  widthMm: number;
  depthMm: number;
}

export const OBJECT_PRESETS: Record<WarehouseObjectTypeName, ObjectPreset> = {
  WALL: { label: "Wall", widthMm: 6000, depthMm: 200 },
  DOOR: { label: "Door", widthMm: 1200, depthMm: 200 },
  AISLE: { label: "Aisle", widthMm: 12000, depthMm: 3000 },
  LOADING_AREA: { label: "Loading area", widthMm: 8000, depthMm: 5000 },
  PACKING_AREA: { label: "Packing area", widthMm: 6000, depthMm: 4000 },
  WORK_AREA: { label: "Work area", widthMm: 5000, depthMm: 4000 },
};

export const RACK_PRESET = {
  lengthMm: 6000,
  depthMm: 1100,
  heightMm: 6000,
  levelCount: 4,
  bayWidthMm: 2000,
  baseElevationMm: 150,
  beamMm: 100,
} as const;

export const GRID_SIZES_MM = [100, 250, 500, 1000, 2000] as const;

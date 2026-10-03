// Plain data shapes exchanged between the warehouse services, the API and the designer UI.
// Type-only: safe to import from client components.
import type { BaySpec, LevelSpec } from "./domain/structure";
import type { WarehouseObjectTypeName } from "./schemas";

export interface WarehouseDto {
  id: string;
  code: string;
  name: string;
  widthMm: number;
  lengthMm: number;
  layoutVersion: number;
}

export interface LayoutObjectDto {
  id: string;
  type: WarehouseObjectTypeName;
  label: string | null;
  xMm: number;
  yMm: number;
  widthMm: number;
  depthMm: number;
  rotationDeg: number;
}

export interface LayoutRackDto {
  id: string;
  code: string;
  name: string | null;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  lengthMm: number;
  depthMm: number;
  heightMm: number;
  levels: LevelSpec[];
  bays: BaySpec[];
}

export interface LayoutDto {
  warehouse: WarehouseDto;
  objects: LayoutObjectDto[];
  racks: LayoutRackDto[];
}

export interface PalletTypeDto {
  id: string;
  name: string;
  widthMm: number;
  lengthMm: number;
  heightMm: number | null;
  maxLoadG: number | null;
}

export interface RackElevationDto {
  rack: { id: string; code: string; name: string | null; lengthMm: number; depthMm: number; heightMm: number };
  levels: { id: string; levelIndex: number; elevationMm: number; clearanceMm: number }[];
  bays: {
    id: string;
    bayIndex: number;
    offsetMm: number;
    widthMm: number;
    positionCount: number;
    palletType: { id: string; name: string; widthMm: number; lengthMm: number } | null;
  }[];
  /** Structured identifiers only; the display code is generated from them (formatLocationCode). */
  positions: { id: string; levelIndex: number; bayIndex: number; positionIndex: number; code: string }[];
}

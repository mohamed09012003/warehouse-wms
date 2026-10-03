import { z } from "zod";
import { LIMITS } from "../domain/structure";

// Generous sanity bounds (a 500 m warehouse, 200 m rack); real limits come from physical validation.
const MAX_MM = 500_000;
const dimMm = z.number().int().min(1).max(MAX_MM);
const coordMm = z.number().int().min(-MAX_MM).max(MAX_MM);
const degrees = z.number().int().min(0).max(359);

export const WAREHOUSE_OBJECT_TYPES = ["WALL", "DOOR", "AISLE", "LOADING_AREA", "PACKING_AREA", "WORK_AREA"] as const;
export type WarehouseObjectTypeName = (typeof WAREHOUSE_OBJECT_TYPES)[number];

const name = z.string().trim().min(1).max(120);

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, "Use letters, digits and single hyphens")
    .max(20),
  name,
  widthMm: dimMm,
  lengthMm: dimMm,
});
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;

export const createPalletTypeSchema = z.object({
  name,
  widthMm: dimMm,
  lengthMm: dimMm,
  heightMm: dimMm.nullish(),
  maxLoadG: z.number().int().min(1).max(100_000_000).nullish(),
});
export type CreatePalletTypeInput = z.infer<typeof createPalletTypeSchema>;

export const levelSpecSchema = z.object({
  elevationMm: z.number().int().min(0).max(MAX_MM),
  clearanceMm: dimMm,
  maxLoadG: z.number().int().min(1).max(100_000_000).nullish(),
});

export const baySpecSchema = z.object({
  widthMm: dimMm,
  positionCount: z.number().int().min(1).max(LIMITS.maxPositionsPerBay),
  palletTypeId: z.uuid().nullish(),
});

export const layoutObjectSchema = z.object({
  id: z.uuid(),
  type: z.enum(WAREHOUSE_OBJECT_TYPES),
  label: z.string().trim().max(120).nullish(),
  xMm: coordMm,
  yMm: coordMm,
  widthMm: dimMm,
  depthMm: dimMm,
  rotationDeg: degrees,
});
export type LayoutObjectInput = z.infer<typeof layoutObjectSchema>;

export const layoutRackSchema = z.object({
  id: z.uuid(),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,12}$/, "Rack code: 1-12 letters/digits, no hyphen"),
  name: z.string().trim().max(120).nullish(),
  xMm: coordMm,
  yMm: coordMm,
  rotationDeg: degrees,
  lengthMm: dimMm,
  depthMm: dimMm,
  heightMm: dimMm,
  levels: z.array(levelSpecSchema).min(1).max(LIMITS.maxLevels),
  bays: z.array(baySpecSchema).min(1).max(LIMITS.maxBays),
});
export type LayoutRackInput = z.infer<typeof layoutRackSchema>;

/** "Save layout": the complete desired state of the floor plan. Items absent from it are deleted. */
export const saveLayoutSchema = z.object({
  /** The layoutVersion the client loaded; a mismatch means someone else saved first. */
  version: z.number().int().min(1),
  warehouse: z.object({ name, widthMm: dimMm, lengthMm: dimMm }),
  objects: z.array(layoutObjectSchema).max(2000),
  racks: z.array(layoutRackSchema).max(1000),
});
export type SaveLayoutInput = z.infer<typeof saveLayoutSchema>;

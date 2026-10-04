import { z } from "zod";

const MAX_QTY = 100_000_000;

/** Optional client-chosen key making a retried request safe (same key + same request is applied once). */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Idempotency key may only contain letters, digits and _ . : -")
  .optional();

// Physical measures are INTEGERS: weight in grams, dimensions in millimetres. Positive when supplied.
const weightG = z.number().int("Weight must be a whole number of grams").min(1, "Weight must be greater than 0").max(1_000_000_000);
const dimMm = z.number().int("Dimensions must be whole millimetres").min(1, "Dimensions must be greater than 0").max(100_000);
const packageType = z.string().trim().min(1).max(40);

const measures = {
  packageType: packageType.nullish(),
  weightG: weightG.nullish(),
  lengthMm: dimMm.nullish(),
  widthMm: dimMm.nullish(),
  heightMm: dimMm.nullish(),
};

/** Length, width and height are given together or not at all. */
const dimensionsTogether = (v: { lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null }) => {
  const given = [v.lengthMm, v.widthMm, v.heightMm].filter((x) => x !== undefined && x !== null).length;
  return given === 0 || given === 3;
};
const DIMENSIONS_MESSAGE = "Enter length, width and height together (or none of them)";

export const startSessionSchema = z.object({ orderId: z.uuid(), idempotencyKey: idempotencyKeySchema });
export const sessionActionSchema = z.object({ sessionId: z.uuid(), idempotencyKey: idempotencyKeySchema });

export const createPackageSchema = z
  .object({ sessionId: z.uuid(), ...measures, idempotencyKey: idempotencyKeySchema })
  .refine(dimensionsTogether, { message: DIMENSIONS_MESSAGE, path: ["lengthMm"] });

export const updatePackageSchema = z
  .object({ packageId: z.uuid(), ...measures, idempotencyKey: idempotencyKeySchema })
  .refine(dimensionsTogether, { message: DIMENSIONS_MESSAGE, path: ["lengthMm"] });

export const packageActionSchema = z.object({ packageId: z.uuid(), idempotencyKey: idempotencyKeySchema });

/**
 * Add picked quantity to an open package. `productCode` is what a person types or a scanner reads
 * (SKU or barcode); `orderLineId` is optional (the order has one line per product).
 */
export const addItemSchema = z.object({
  packageId: z.uuid(),
  productCode: z.string().trim().min(1, "Enter the product SKU or barcode").max(128),
  orderLineId: z.uuid().optional(),
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_QTY),
  idempotencyKey: idempotencyKeySchema,
});

export const setItemQuantitySchema = z.object({
  itemId: z.uuid(),
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1 (remove the item instead)").max(MAX_QTY),
  idempotencyKey: idempotencyKeySchema,
});

export const removeItemSchema = z.object({ itemId: z.uuid(), idempotencyKey: idempotencyKeySchema });

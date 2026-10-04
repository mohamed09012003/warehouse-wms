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

export const orderActionSchema = z.object({ orderId: z.uuid(), idempotencyKey: idempotencyKeySchema });

export const createWaveSchema = z.object({ note: z.string().trim().max(300).nullish() });

export const addOrdersToWaveSchema = z.object({
  waveId: z.uuid(),
  orderIds: z.array(z.uuid()).min(1).max(100).refine((ids) => new Set(ids).size === ids.length, "Duplicate orders"),
});

export const waveActionSchema = z.object({ waveId: z.uuid() });

/**
 * A pick confirmation. `locationCode` and `productCode` are exactly what a picker types or a
 * scanner reads: a location code, and a SKU or barcode. A future scanner calls the same operation.
 */
export const confirmPickSchema = z.object({
  taskId: z.uuid(),
  locationCode: z.string().trim().min(1, "Confirm the location").max(60),
  productCode: z.string().trim().min(1, "Confirm the product").max(128),
  quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_QTY),
  idempotencyKey: idempotencyKeySchema,
});
export type ConfirmPickInput = z.infer<typeof confirmPickSchema>;

export const listTasksSchema = z.object({
  status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  waveId: z.uuid().optional(),
});

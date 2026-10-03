import { z } from "zod";

// Per-operation limit, well below the database cap on a balance (1e9), so one request can never overflow.
export const MAX_OPERATION_QUANTITY = 100_000_000;

const quantity = z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_OPERATION_QUANTITY);
const reason = z.string().trim().min(1).max(200);

/** Optional client-chosen key making a retried request safe: the same key + same request is applied once. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(100)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Idempotency key may only contain letters, digits and _ . : -")
  .optional();

export const receiveStockSchema = z.object({
  productId: z.uuid(),
  positionId: z.uuid(),
  quantity,
  reason: reason.optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type ReceiveStockInput = z.infer<typeof receiveStockSchema>;

export const moveStockSchema = z
  .object({
    productId: z.uuid(),
    fromPositionId: z.uuid(),
    toPositionId: z.uuid(),
    quantity,
    reason: reason.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((v) => v.fromPositionId !== v.toPositionId, { message: "Source and destination must be different positions", path: ["toPositionId"] });
export type MoveStockInput = z.infer<typeof moveStockSchema>;

export const adjustStockSchema = z.object({
  productId: z.uuid(),
  positionId: z.uuid(),
  /** Positive increases on-hand, negative decreases it. */
  delta: z
    .number()
    .int("Adjustment must be a whole number")
    .refine((n) => n !== 0, "Adjustment cannot be zero")
    .refine((n) => Math.abs(n) <= MAX_OPERATION_QUANTITY, "Adjustment is too large"),
  // A reason is mandatory for adjustments (audit).
  reason,
  idempotencyKey: idempotencyKeySchema,
});
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const createReservationSchema = z.object({
  lines: z
    .array(z.object({ productId: z.uuid(), positionId: z.uuid(), quantity }))
    .min(1)
    .max(100)
    .refine((lines) => new Set(lines.map((l) => `${l.positionId}:${l.productId}`)).size === lines.length, "Duplicate product/position lines"),
  refType: z.string().trim().max(50).optional(),
  refId: z.string().trim().max(100).optional(),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: idempotencyKeySchema,
});
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const releaseReservationSchema = z.object({ reservationId: z.uuid(), idempotencyKey: idempotencyKeySchema });

export const listStockSchema = z.object({
  productId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  search: z.string().trim().max(100).optional(),
});

export const listMovementsSchema = z.object({
  productId: z.uuid().optional(),
  positionId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

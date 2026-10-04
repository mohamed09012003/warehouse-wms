import { z } from "zod";

export const MAX_ORDER_QUANTITY = 100_000_000;

/** Order numbers are normalized to uppercase and limited to characters that are safe in codes, URLs and CSV. */
export const ORDER_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;

export const orderNumberSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(ORDER_NUMBER_PATTERN, "Order number: 1-40 characters; letters, digits and . _ / - only (must start with a letter or digit)");

export const createOrderSchema = z.object({
  orderNumber: orderNumberSchema,
  externalRef: z.string().trim().max(100).nullish(),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: z.number().int("Quantity must be a whole number").min(1, "Quantity must be at least 1").max(MAX_ORDER_QUANTITY),
      }),
    )
    .min(1, "An order needs at least one line")
    .max(200)
    .refine((lines) => new Set(lines.map((l) => l.productId)).size === lines.length, "Each product can appear only once per order"),
  /** Create the order already READY for allocation instead of DRAFT. */
  ready: z.boolean().optional(),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const listOrdersSchema = z.object({
  status: z.enum(["DRAFT", "READY", "PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING", "PICKED", "CANCELLED"]).optional(),
  search: z.string().trim().max(60).optional(),
});

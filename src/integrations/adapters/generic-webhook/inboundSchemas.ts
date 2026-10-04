// Provider-specific payload shapes for the generic webhook adapter (the `data` of an envelope).
// Deliberately loose about WMS rules (SKU/order-number patterns are enforced by the core services
// that receive the translated data) and strict about structure.
import { z } from "zod";

const externalId = z.string().trim().min(1, "externalId is required").max(200);

export const envelopeSchema = z.object({
  eventId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:-]+$/, "eventId may contain letters, digits and . _ : - only"),
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "type must look like product.upsert"),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});

export const productUpsertSchema = z.object({
  externalId,
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullish(),
  barcodes: z.array(z.string().trim().min(1).max(128)).max(50).optional(),
});
export type ProductUpsertData = z.infer<typeof productUpsertSchema>;

export const orderCreateSchema = z.object({
  externalId,
  /** WMS order number; defaults to the external id (uppercased by the order service). */
  orderNumber: z.string().trim().min(1).max(40).optional(),
  note: z.string().trim().max(500).nullish(),
  /** Create the order READY for allocation (default) or as a DRAFT. */
  ready: z.boolean().optional(),
  lines: z
    .array(
      z
        .object({
          /** Reference to a product previously sent as product.upsert. */
          externalProductId: z.string().trim().min(1).max(200).optional(),
          /** SKU (or barcode) known to the WMS. */
          sku: z.string().trim().min(1).max(128).optional(),
          quantity: z.number().int().min(1).max(100_000_000),
        })
        .refine((l) => l.externalProductId || l.sku, "Each line needs externalProductId or sku"),
    )
    .min(1, "An order needs at least one line")
    .max(200),
});
export type OrderCreateData = z.infer<typeof orderCreateSchema>;

export const orderCancelSchema = z.object({ externalId });
export type OrderCancelData = z.infer<typeof orderCancelSchema>;

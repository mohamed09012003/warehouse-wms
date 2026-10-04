import { z } from "zod";

/** SKUs are normalized to uppercase and limited to characters that are safe in codes, URLs and CSV. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(SKU_PATTERN, "SKU: 1-64 characters; letters, digits and . _ / - only (must start with a letter or digit)");

// No barcode format is assumed (EAN, UPC, QR payloads and internal codes are all valid):
// any text without control characters or surrounding whitespace, up to 128 characters.
export const barcodeSchema = z
  .string()
  .trim()
  .min(1, "Barcode is required")
  .max(128)
  .regex(/^[^\p{Cc}]+$/u, "Barcode must not contain control characters");

export const createProductSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(2000).nullish(),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

// SKU is immutable after creation (other systems and stock history refer to it).
export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// Create-or-update by SKU (used by integrations). Barcodes are ADD-ONLY: missing ones are added, none are removed.
export const upsertProductSchema = z.object({
  sku: skuSchema,
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(2000).nullish(),
  barcodes: z.array(barcodeSchema).max(50).optional(),
});
export type UpsertProductInput = z.infer<typeof upsertProductSchema>;

export const addBarcodeSchema = z.object({ barcode: barcodeSchema });

export const listProductsSchema = z.object({
  search: z.string().trim().max(100).optional(),
  includeInactive: z.boolean().optional(),
});

// Zod schemas for the admin API (input from the browser). Provider-specific configuration is validated
// separately by the provider's own config schema.
import { z } from "zod";

export const integrationNameSchema = z.string().trim().min(1, "Name is required").max(80);

export const createIntegrationSchema = z.object({
  name: integrationNameSchema,
  provider: z.string().trim().min(1).max(40),
  inboundEnabled: z.boolean().default(true),
  outboundEnabled: z.boolean().default(false),
  config: z.record(z.string(), z.unknown()).default({}),
  /** Optional. Omitted = the provider's default grants. Anything else is Owner-only. */
  grants: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

export const updateIntegrationSchema = z
  .object({
    name: integrationNameSchema.optional(),
    inboundEnabled: z.boolean().optional(),
    outboundEnabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    /** Owner-only. */
    grants: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export const disableIntegrationSchema = z.object({ reason: z.string().trim().max(200).nullish() });

/** A secret value: printable ASCII without spaces, long enough to be a real key. Never echoed back. */
export const secretValueSchema = z.object({
  value: z
    .string()
    .min(16, "A secret must be at least 16 characters")
    .max(512)
    .regex(/^[\x21-\x7e]+$/, "A secret may contain printable ASCII characters without spaces"),
});

export const secretNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

const limit = z.coerce.number().int().min(1).max(200).default(50);

export const listInboundEventsSchema = z.object({
  status: z.enum(["RECEIVED", "PROCESSING", "SUCCEEDED", "FAILED", "REJECTED", "DEAD"]).optional(),
  limit,
});
export const listDeliveriesSchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "DEAD"]).optional(),
  limit,
});
export const listLogsSchema = z.object({ limit });

export const idSchema = z.uuid();

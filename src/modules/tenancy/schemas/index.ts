import { z } from "zod";
import { createUserSchema } from "@/modules/identity/schemas";
import { isValidSlug } from "../domain/slug";

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidSlug, "Slug must be 2-48 chars: lowercase letters, digits and single hyphens (and not reserved)");

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema,
  // The first user becomes Owner. Either create a new identity or reuse an existing one.
  owner: z.union([
    z.object({ userId: z.uuid() }),
    createUserSchema,
  ]),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

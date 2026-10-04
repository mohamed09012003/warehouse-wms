// Validated, server-only environment. Never import this from client components,
// and never log the parsed object (it contains secrets).
import "server-only";
import { z } from "zod";
import { isValidKeyring } from "@/lib/keyring";

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "DATABASE_URL must be a postgresql:// URL"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  // Integration secret vault keys: "keyId:base64(32 bytes)[,keyId2:...]"; the first key encrypts. Optional so the
  // app runs without integrations, but the vault, the webhook endpoint and the worker refuse to work without it.
  INTEGRATION_ENCRYPTION_KEYS: z
    .string()
    .optional()
    .refine((v) => !v || v.trim() === "" || isValidKeyring(v), "INTEGRATION_ENCRYPTION_KEYS must be keyId:base64(32 bytes), comma separated"),
  // Test/dev only: allow outbound integration calls to loopback/private addresses over http. Ignored in production.
  INTEGRATIONS_ALLOW_PRIVATE_TARGETS: z.enum(["true", "false"]).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validate an environment object. Error text names variables and rules, never values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}

export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

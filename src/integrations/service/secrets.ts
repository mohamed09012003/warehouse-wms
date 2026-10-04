// Write-only secret management. A secret value goes IN through setIntegrationSecret and never comes back
// out of any API: reads return metadata only (name, isSet, rotatedAt, hasPrevious).
import { AppError, ValidationError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { logSafe } from "../core/logger";
import { secretNameSchema, secretValueSchema } from "../schemas";
import { secretStore } from "../secrets/secretStore";
import { VaultError } from "../secrets/vault";
import type { SecretMetaDto } from "../types";
import { providerOrThrow, requireIntegration, secretNamesOf } from "./integrations";

function allowedName(provider: ReturnType<typeof providerOrThrow>, rawName: string): string {
  const name = secretNameSchema.safeParse(rawName);
  if (!name.success || !secretNamesOf(provider).includes(name.data)) {
    throw new ValidationError(`Unknown secret "${rawName.slice(0, 40)}" for this provider`);
  }
  return name.data;
}

async function metaOf(ctx: TenantContext, integrationId: string, name: string): Promise<SecretMetaDto> {
  const [meta] = await secretStore.metadata(ctx.organizationId, integrationId, [name]);
  return { name, isSet: meta.isSet, rotatedAt: meta.rotatedAt?.toISOString() ?? null, hasPrevious: meta.hasPrevious };
}

/** Store (or rotate) a secret. The previous value stays valid for inbound signatures during the grace period. */
export async function setIntegrationSecret(ctx: TenantContext, integrationId: string, rawName: string, raw: unknown): Promise<SecretMetaDto> {
  requirePermission(ctx, "integrations.manage");
  const integration = await requireIntegration(ctx, integrationId);
  const name = allowedName(providerOrThrow(integration.provider), rawName);
  const { value } = parseInput(secretValueSchema, raw);
  try {
    await secretStore.put(ctx.organizationId, integration.id, name, value);
  } catch (error) {
    if (error instanceof VaultError) throw new AppError("INTERNAL_ERROR", 503, "The secret vault is not configured on this server");
    throw error;
  }
  // Audit trail in the log stream: who changed which secret, never the value.
  logSafe("info", "admin.secret_set", { integrationId: integration.id, organizationId: ctx.organizationId, actorUserId: ctx.userId, secretName: name });
  return metaOf(ctx, integration.id, name);
}

export async function deleteIntegrationSecret(ctx: TenantContext, integrationId: string, rawName: string): Promise<SecretMetaDto> {
  requirePermission(ctx, "integrations.manage");
  const integration = await requireIntegration(ctx, integrationId);
  const provider = providerOrThrow(integration.provider);
  const name = allowedName(provider, rawName);
  if (integration.enabled) {
    const meta = await secretStore.metadata(ctx.organizationId, integration.id, secretNamesOf(provider));
    const remaining = new Set(meta.filter((s) => s.isSet && s.name !== name).map((s) => s.name));
    const problems = provider.readiness(integration, remaining);
    if (problems.length > 0) throw new ValidationError(`Disable the integration before removing a required secret: ${problems.join("; ")}`);
  }
  await secretStore.remove(ctx.organizationId, integration.id, name);
  logSafe("info", "admin.secret_deleted", { integrationId: integration.id, organizationId: ctx.organizationId, actorUserId: ctx.userId, secretName: name });
  return metaOf(ctx, integration.id, name);
}

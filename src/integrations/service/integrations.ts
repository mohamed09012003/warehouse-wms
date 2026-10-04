// Administration of integration records (permission integrations.view / integrations.manage).
// Everything is tenant-scoped through the TenantContext; secrets are never read here, only their metadata.
import { randomBytes } from "node:crypto";
import { AuthorizationError, ConflictError, InvalidStateError, NotFoundError, ValidationError, parseInput } from "@/lib/errors";
import { findSecretLookingKeys } from "@/lib/redact";
import { createIntegrationServiceUser } from "@/modules/identity";
import { OWNER_ROLE_NAME, requirePermission, type TenantContext } from "@/modules/tenancy";
import { withTransaction } from "@/server/db";
import { isAllowedGrant } from "../core/grants";
import { logSafe } from "../core/logger";
import { getProvider } from "../core/registry";
import type { ProviderDefinition } from "../core/types";
import { integrationRepo, type IntegrationRow } from "../repo/integrationRepo";
import type { JsonInput } from "../repo/json";
import { appendLog } from "../repo/logRepo";
import { secretStore } from "../secrets/secretStore";
import { createIntegrationSchema, disableIntegrationSchema, updateIntegrationSchema } from "../schemas";
import type { IntegrationDto } from "../types";

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

export function providerOrThrow(name: string): ProviderDefinition {
  const provider = getProvider(name);
  if (!provider) throw new ValidationError(`Unknown provider "${name}"`);
  return provider;
}

export function secretNamesOf(provider: ProviderDefinition): string[] {
  return [...new Set([...(provider.inbound?.secretNames ?? []), ...(provider.outbound?.secretNames ?? [])])];
}

/** Validate provider configuration: no secret-looking keys anywhere, then the provider's own schema. */
export function validateConfig(provider: ProviderDefinition, config: Record<string, unknown>): Record<string, unknown> {
  const secretKeys = findSecretLookingKeys(config);
  if (secretKeys.length > 0) {
    throw new ValidationError(`Configuration must not contain secrets (field "${secretKeys[0]}"). Store secrets with the secrets API instead.`);
  }
  const schema = (provider.inbound ?? provider.outbound)?.configSchema;
  if (!schema) throw new ValidationError("This provider has no configuration schema");
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ValidationError("Invalid configuration", parsed.error.issues);
  return parsed.data as Record<string, unknown>;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Grants must be allowlisted; anything other than the provider's default (or the current value) is Owner-only. */
function resolveGrants(ctx: TenantContext, requested: readonly string[] | undefined, current: readonly string[]): string[] {
  const grants = [...new Set(requested ?? current)];
  for (const g of grants) {
    if (!isAllowedGrant(g)) throw new ValidationError(`Permission "${g}" can never be granted to an integration`);
  }
  if (requested !== undefined && !sameSet(grants, current) && ctx.roleName !== OWNER_ROLE_NAME) {
    throw new AuthorizationError("Only an Owner can change the permissions of an integration");
  }
  return grants;
}

async function toDto(ctx: TenantContext, row: IntegrationRow): Promise<IntegrationDto> {
  const provider = getProvider(row.provider);
  const names = provider ? secretNamesOf(provider) : [];
  const secrets = await secretStore.metadata(ctx.organizationId, row.id, names);
  const secretsSet = new Set(secrets.filter((s) => s.isSet).map((s) => s.name));
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerLabel: provider?.label ?? row.provider,
    webhookPath: `/api/webhooks/${row.publicId}`,
    inboundEnabled: row.inboundEnabled,
    outboundEnabled: row.outboundEnabled,
    enabled: row.enabled,
    disabledReason: row.disabledReason,
    config: (row.config ?? {}) as Record<string, unknown>,
    grants: row.grants,
    inbound: {
      healthStatus: row.inboundHealthStatus,
      lastSuccessAt: row.inboundLastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.inboundLastFailureAt?.toISOString() ?? null,
      consecutiveFailures: row.inboundConsecutiveFailures,
      lastErrorSummary: row.inboundLastErrorSummary,
    },
    outbound: {
      healthStatus: row.outboundHealthStatus,
      lastSuccessAt: row.outboundLastSuccessAt?.toISOString() ?? null,
      lastFailureAt: row.outboundLastFailureAt?.toISOString() ?? null,
      consecutiveFailures: row.outboundConsecutiveFailures,
      lastErrorSummary: row.outboundLastErrorSummary,
    },
    outboundPausedAt: row.outboundPausedAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    secrets: secrets.map((s) => ({ name: s.name, isSet: s.isSet, rotatedAt: s.rotatedAt?.toISOString() ?? null, hasPrevious: s.hasPrevious })),
    readinessProblems: provider ? provider.readiness({ inboundEnabled: row.inboundEnabled, outboundEnabled: row.outboundEnabled, config: row.config }, secretsSet) : ["Unknown provider"],
  };
}

/** Load an integration of the caller's organization or throw NotFound (also for ids of other tenants). */
export async function requireIntegration(ctx: TenantContext, id: string): Promise<IntegrationRow> {
  const row = await integrationRepo(ctx).findById(id);
  if (!row) throw new NotFoundError("Integration not found");
  return row;
}

export async function listIntegrations(ctx: TenantContext, includeArchived = false): Promise<IntegrationDto[]> {
  requirePermission(ctx, "integrations.view");
  const rows = await integrationRepo(ctx).list(includeArchived);
  return Promise.all(rows.map((r) => toDto(ctx, r)));
}

export async function getIntegration(ctx: TenantContext, id: string): Promise<IntegrationDto> {
  requirePermission(ctx, "integrations.view");
  return toDto(ctx, await requireIntegration(ctx, id));
}

export async function createIntegration(ctx: TenantContext, raw: unknown): Promise<IntegrationDto> {
  requirePermission(ctx, "integrations.manage");
  const input = parseInput(createIntegrationSchema, raw);
  const provider = providerOrThrow(input.provider);
  if (input.inboundEnabled && !provider.inbound) throw new ValidationError("This provider does not support inbound events");
  if (input.outboundEnabled && !provider.outbound) throw new ValidationError("This provider does not support outbound events");
  const config = validateConfig(provider, input.config);
  const grants = resolveGrants(ctx, input.grants, provider.defaultGrants);

  try {
    const row = await withTransaction(async (tx) => {
      const serviceUser = await createIntegrationServiceUser(tx, input.name);
      return integrationRepo(ctx, tx).create({
        publicId: randomBytes(16).toString("base64url"),
        name: input.name,
        provider: provider.provider,
        inboundEnabled: input.inboundEnabled,
        outboundEnabled: input.outboundEnabled,
        config: config as JsonInput,
        grants,
        serviceUserId: serviceUser.id,
      });
    });
    logSafe("info", "admin.integration_created", { integrationId: row.id, organizationId: ctx.organizationId, actorUserId: ctx.userId, provider: row.provider });
    return toDto(ctx, row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`An integration named "${input.name}" already exists`);
    throw error;
  }
}

export async function updateIntegration(ctx: TenantContext, id: string, raw: unknown): Promise<IntegrationDto> {
  requirePermission(ctx, "integrations.manage");
  const input = parseInput(updateIntegrationSchema, raw);
  const row = await requireIntegration(ctx, id);
  const provider = providerOrThrow(row.provider);

  const inboundEnabled = input.inboundEnabled ?? row.inboundEnabled;
  const outboundEnabled = input.outboundEnabled ?? row.outboundEnabled;
  if (inboundEnabled && !provider.inbound) throw new ValidationError("This provider does not support inbound events");
  if (outboundEnabled && !provider.outbound) throw new ValidationError("This provider does not support outbound events");
  const config = input.config ? validateConfig(provider, input.config) : (row.config as Record<string, unknown>);
  const grants = input.grants !== undefined ? resolveGrants(ctx, input.grants, row.grants) : row.grants;

  // An enabled integration must stay ready: reject a change that would leave it half-configured.
  if (row.enabled && input.archived !== true) {
    const meta = await secretStore.metadata(ctx.organizationId, row.id, secretNamesOf(provider));
    const problems = provider.readiness({ inboundEnabled, outboundEnabled, config }, new Set(meta.filter((s) => s.isSet).map((s) => s.name)));
    if (problems.length > 0) throw new ValidationError(`Disable the integration first: ${problems.join("; ")}`);
  }

  const archiving = input.archived === true;
  const { count } = await integrationRepo(ctx).update(id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    inboundEnabled,
    outboundEnabled,
    config: config as JsonInput,
    grants,
    ...(archiving ? { archivedAt: new Date(), enabled: false, disabledReason: "Archived" } : {}),
    ...(input.archived === false ? { archivedAt: null } : {}),
  }).catch((error) => {
    if (isUniqueViolation(error)) throw new ConflictError(`An integration named "${input.name}" already exists`);
    throw error;
  });
  if (count === 0) throw new NotFoundError("Integration not found");
  logSafe("info", "admin.integration_updated", { integrationId: id, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  return getIntegration(ctx, id);
}

export async function enableIntegration(ctx: TenantContext, id: string): Promise<IntegrationDto> {
  requirePermission(ctx, "integrations.manage");
  const row = await requireIntegration(ctx, id);
  if (row.archivedAt) throw new InvalidStateError("An archived integration cannot be enabled");
  const provider = providerOrThrow(row.provider);
  const meta = await secretStore.metadata(ctx.organizationId, row.id, secretNamesOf(provider));
  const problems = provider.readiness(row, new Set(meta.filter((s) => s.isSet).map((s) => s.name)));
  if (problems.length > 0) throw new ValidationError(`The integration is not ready to be enabled: ${problems.join("; ")}`);

  if (!(await integrationRepo(ctx).enable(id))) throw new InvalidStateError("The integration could not be enabled");
  if (row.outboundPausedAt) {
    await appendLog({
      organizationId: ctx.organizationId,
      integrationId: id,
      direction: "OUTBOUND",
      provider: row.provider,
      correlationId: crypto.randomUUID(),
      status: "RESUMED",
      safeSummary: "Outbound delivery resumed by an administrator",
    });
  }
  logSafe("info", "admin.integration_enabled", { integrationId: id, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  return getIntegration(ctx, id);
}

export async function disableIntegration(ctx: TenantContext, id: string, raw: unknown = {}): Promise<IntegrationDto> {
  requirePermission(ctx, "integrations.manage");
  const { reason } = parseInput(disableIntegrationSchema, raw);
  await requireIntegration(ctx, id);
  await integrationRepo(ctx).update(id, { enabled: false, disabledReason: reason ?? "Disabled by an administrator" });
  logSafe("info", "admin.integration_disabled", { integrationId: id, organizationId: ctx.organizationId, actorUserId: ctx.userId });
  return getIntegration(ctx, id);
}

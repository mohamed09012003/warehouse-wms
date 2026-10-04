// Integration records. Two flavours of access:
//   - tenant-scoped (integrationRepo(ctx)): the admin API; every query carries the organization id
//   - system level (systemIntegrationRepo): the public webhook endpoint and the worker, which start from a
//     publicId / row id and have no user session. They never accept an organization id from a caller.
// No query here selects secrets: they live in IntegrationSecret, read only by secrets/secretStore.ts.
import type { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/modules/tenancy";
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";
import { DEGRADED_AFTER, FAILING_AFTER, PAUSE_OUTBOUND_AFTER } from "../core/health";

const selectSafe = {
  id: true,
  organizationId: true,
  publicId: true,
  name: true,
  provider: true,
  inboundEnabled: true,
  outboundEnabled: true,
  enabled: true,
  disabledReason: true,
  config: true,
  grants: true,
  serviceUserId: true,
  inboundHealthStatus: true,
  inboundLastSuccessAt: true,
  inboundLastFailureAt: true,
  inboundConsecutiveFailures: true,
  inboundLastErrorSummary: true,
  outboundHealthStatus: true,
  outboundLastSuccessAt: true,
  outboundLastFailureAt: true,
  outboundConsecutiveFailures: true,
  outboundLastErrorSummary: true,
  outboundPausedAt: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.IntegrationSelect;

export type IntegrationRow = Prisma.IntegrationGetPayload<{ select: typeof selectSafe }>;
export type SystemIntegrationRow = IntegrationRow & { organization: { slug: string } };

export function integrationRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  return {
    list: (includeArchived = false) =>
      db.integration.findMany({
        where: { ...org, ...(includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ name: "asc" }],
        select: selectSafe,
      }),
    findById: (id: string) => db.integration.findFirst({ where: { ...org, id }, select: selectSafe }),
    create: (data: {
      publicId: string;
      name: string;
      provider: string;
      inboundEnabled: boolean;
      outboundEnabled: boolean;
      config: Prisma.InputJsonValue;
      grants: string[];
      serviceUserId: string;
    }) => db.integration.create({ data: { ...data, organizationId: ctx.organizationId }, select: selectSafe }),
    update: (id: string, data: Prisma.IntegrationUpdateManyMutationInput) => db.integration.updateMany({ where: { ...org, id }, data }),
    /** Re-enable: clears the OUTBOUND circuit breaker and outbound failure streak (inbound health is left alone). Returns true when a row changed. */
    async enable(id: string): Promise<boolean> {
      const { count } = await db.integration.updateMany({
        where: { ...org, id, archivedAt: null },
        data: { enabled: true, disabledReason: null, outboundPausedAt: null, outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY" },
      });
      return count === 1;
    },
  };
}

export const systemIntegrationRepo = {
  findByPublicId: (publicId: string, db: DbClient = prisma): Promise<SystemIntegrationRow | null> =>
    db.integration.findUnique({ where: { publicId }, select: { ...selectSafe, organization: { select: { slug: true } } } }),
  findById: (id: string, db: DbClient = prisma): Promise<SystemIntegrationRow | null> =>
    db.integration.findFirst({ where: { id }, select: { ...selectSafe, organization: { select: { slug: true } } } }),

  /**
   * Record a successful INBOUND outcome. Touches only the inbound columns: it never resets the outbound
   * failure streak or the circuit breaker.
   */
  async recordInboundSuccess(integrationId: string, now: Date, db: DbClient = prisma): Promise<void> {
    await db.integration.updateMany({
      where: { id: integrationId },
      data: { inboundConsecutiveFailures: 0, inboundHealthStatus: "HEALTHY", inboundLastSuccessAt: now, inboundLastErrorSummary: null },
    });
  },

  /**
   * Record a successful OUTBOUND outcome. Touches only the outbound columns (the inbound streak is untouched).
   * The pause flag is cleared only by an admin enabling the integration again.
   */
  async recordOutboundSuccess(integrationId: string, now: Date, db: DbClient = prisma): Promise<void> {
    await db.integration.updateMany({
      where: { id: integrationId },
      data: { outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY", outboundLastSuccessAt: now, outboundLastErrorSummary: null },
    });
  },

  /** Record an INBOUND failure atomically. Inbound failures can never pause outbound delivery. */
  async recordInboundFailure(integrationId: string, summary: string, now: Date, db: DbClient = prisma): Promise<{ consecutiveFailures: number }> {
    const rows = await db.$queryRaw<{ inboundConsecutiveFailures: number }[]>`
      UPDATE "Integration" SET
        "inboundConsecutiveFailures" = "inboundConsecutiveFailures" + 1,
        "inboundLastFailureAt" = ${now}::timestamptz,
        "inboundLastErrorSummary" = ${summary.slice(0, 300)},
        "inboundHealthStatus" = CASE
          WHEN "inboundConsecutiveFailures" + 1 >= ${FAILING_AFTER}::int THEN 'FAILING'::"IntegrationHealth"
          WHEN "inboundConsecutiveFailures" + 1 >= ${DEGRADED_AFTER}::int THEN 'DEGRADED'::"IntegrationHealth"
          ELSE "inboundHealthStatus" END
      WHERE "id" = ${integrationId}::uuid
      RETURNING "inboundConsecutiveFailures"`;
    return { consecutiveFailures: rows[0]?.inboundConsecutiveFailures ?? 0 };
  },

  /**
   * Record an OUTBOUND failure atomically: outbound streak +1, outbound health derived from it, and the circuit
   * breaker trips (outboundPausedAt) when the OUTBOUND streak reaches the pause threshold. Returns whether THIS call paused it.
   */
  async recordOutboundFailure(integrationId: string, summary: string, now: Date, db: DbClient = prisma): Promise<{ consecutiveFailures: number; newlyPaused: boolean }> {
    const rows = await db.$queryRaw<{ outboundConsecutiveFailures: number; outboundPausedAt: Date | null }[]>`
      UPDATE "Integration" SET
        "outboundConsecutiveFailures" = "outboundConsecutiveFailures" + 1,
        "outboundLastFailureAt" = ${now}::timestamptz,
        "outboundLastErrorSummary" = ${summary.slice(0, 300)},
        "outboundHealthStatus" = CASE
          WHEN "outboundConsecutiveFailures" + 1 >= ${FAILING_AFTER}::int THEN 'FAILING'::"IntegrationHealth"
          WHEN "outboundConsecutiveFailures" + 1 >= ${DEGRADED_AFTER}::int THEN 'DEGRADED'::"IntegrationHealth"
          ELSE "outboundHealthStatus" END,
        "outboundPausedAt" = CASE
          WHEN "outboundEnabled" AND "outboundPausedAt" IS NULL AND "outboundConsecutiveFailures" + 1 >= ${PAUSE_OUTBOUND_AFTER}::int
            THEN ${now}::timestamptz ELSE "outboundPausedAt" END
      WHERE "id" = ${integrationId}::uuid
      RETURNING "outboundConsecutiveFailures", "outboundPausedAt"`;
    const row = rows[0];
    if (!row) return { consecutiveFailures: 0, newlyPaused: false };
    return { consecutiveFailures: row.outboundConsecutiveFailures, newlyPaused: row.outboundPausedAt?.getTime() === now.getTime() };
  },
};

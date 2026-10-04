// IntegrationDelivery persistence: one row per (integration, outbox event).
//
//   PENDING --claim--> PROCESSING --2xx--> SUCCEEDED
//                         |--retryable--> FAILED --(backoff, or Retry-After)--> claim again ... --> DEAD
//                         |--permanent--> DEAD (replayable)
//   PROCESSING with an expired lease -> reaped to FAILED/DEAD
//
// Same conventions as inboundRepo: `attempts` counts started attempts and every transition out of
// PROCESSING is guarded by (status, attempts). Paused (circuit-breaker) or disabled integrations are never
// claimed, so their deliveries simply wait.
import type { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/modules/tenancy";
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";
import { DEFAULT_MAX_ATTEMPTS, LEASE_SECONDS } from "../core/retry";

export interface ClaimedDelivery {
  id: string;
  organizationId: string;
  integrationId: string;
  outboxEventId: string;
  attempts: number;
}

export interface ReapedDelivery {
  id: string;
  organizationId: string;
  integrationId: string;
  outboxEventId: string;
  status: "FAILED" | "DEAD";
  attempts: number;
}

export interface DeliveryEventRow {
  id: string;
  seq: bigint;
  eventType: string;
  schemaVersion: number;
  occurredAt: Date;
  payload: unknown;
}

export const deliveryRepo = {
  async claim(now: Date, limit: number, db: DbClient = prisma): Promise<ClaimedDelivery[]> {
    return db.$queryRaw<ClaimedDelivery[]>`
      WITH due AS (
        SELECT d."id" FROM "IntegrationDelivery" d
        JOIN "Integration" i ON i."organizationId" = d."organizationId" AND i."id" = d."integrationId"
        WHERE d."status" IN ('PENDING', 'FAILED') AND d."nextAttemptAt" <= ${now}::timestamptz
          AND i."enabled" AND i."outboundEnabled" AND i."archivedAt" IS NULL AND i."outboundPausedAt" IS NULL
        ORDER BY d."nextAttemptAt", d."createdAt", d."id"
        LIMIT ${limit}::int
        FOR UPDATE OF d SKIP LOCKED)
      UPDATE "IntegrationDelivery" d SET
        "status" = 'PROCESSING', "attempts" = d."attempts" + 1,
        "lockedUntil" = ${now}::timestamptz + make_interval(secs => ${LEASE_SECONDS}::double precision),
        "updatedAt" = ${now}::timestamptz
      FROM due WHERE d."id" = due."id"
      RETURNING d."id", d."organizationId", d."integrationId", d."outboxEventId", d."attempts"`;
  },

  async reapExpired(now: Date, db: DbClient = prisma): Promise<ReapedDelivery[]> {
    return db.$queryRaw<ReapedDelivery[]>`
      UPDATE "IntegrationDelivery" d SET
        "status" = CASE WHEN d."attempts" >= COALESCE((i."config"->>'maxAttempts')::int, ${DEFAULT_MAX_ATTEMPTS}::int) THEN 'DEAD'::"IntegrationDeliveryStatus" ELSE 'FAILED'::"IntegrationDeliveryStatus" END,
        "lockedUntil" = NULL, "nextAttemptAt" = ${now}::timestamptz,
        "lastErrorCode" = 'LEASE_EXPIRED', "lastErrorSummary" = 'Delivery did not finish before the lease expired',
        "updatedAt" = ${now}::timestamptz
      FROM "Integration" i
      WHERE i."organizationId" = d."organizationId" AND i."id" = d."integrationId"
        AND d."status" = 'PROCESSING' AND d."lockedUntil" < ${now}::timestamptz
      RETURNING d."id", d."organizationId", d."integrationId", d."outboxEventId", d."status"::text AS "status", d."attempts"`;
  },

  async loadEvent(organizationId: string, outboxEventId: string, db: DbClient = prisma): Promise<DeliveryEventRow | null> {
    const rows = await db.$queryRaw<DeliveryEventRow[]>`
      SELECT "id", "seq", "eventType", "schemaVersion", "occurredAt", "payload" FROM "OutboxEvent"
      WHERE "organizationId" = ${organizationId}::uuid AND "id" = ${outboxEventId}::uuid`;
    return rows[0] ?? null;
  },

  async markSucceeded(id: string, attempts: number, httpStatus: number | null, now: Date, db: DbClient = prisma): Promise<number> {
    return (
      await db.integrationDelivery.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "SUCCEEDED", lockedUntil: null, deliveredAt: now, lastHttpStatus: httpStatus, lastErrorCode: null, lastErrorSummary: null },
      })
    ).count;
  },
  async markFailed(id: string, attempts: number, code: string, summary: string, httpStatus: number | null, nextAttemptAt: Date, db: DbClient = prisma): Promise<number> {
    return (
      await db.integrationDelivery.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "FAILED", lockedUntil: null, lastErrorCode: code, lastErrorSummary: summary, lastHttpStatus: httpStatus, nextAttemptAt },
      })
    ).count;
  },
  async markDead(id: string, attempts: number, code: string, summary: string, httpStatus: number | null, db: DbClient = prisma): Promise<number> {
    return (
      await db.integrationDelivery.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "DEAD", lockedUntil: null, lastErrorCode: code, lastErrorSummary: summary, lastHttpStatus: httpStatus },
      })
    ).count;
  },
};

const listSelect = {
  id: true,
  outboxEventId: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  lastHttpStatus: true,
  lastErrorCode: true,
  lastErrorSummary: true,
  deliveredAt: true,
  createdAt: true,
  outboxEvent: { select: { eventType: true, occurredAt: true } },
} satisfies Prisma.IntegrationDeliverySelect;

export type DeliveryListRow = Prisma.IntegrationDeliveryGetPayload<{ select: typeof listSelect }>;

export function deliveryAdminRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  return {
    list: (integrationId: string, filter: { status?: Prisma.IntegrationDeliveryWhereInput["status"] }, limit: number) =>
      db.integrationDelivery.findMany({
        where: { ...org, integrationId, ...(filter.status ? { status: filter.status } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: listSelect,
      }),
    /** Put a DEAD/FAILED delivery back in the queue with a fresh attempt budget. Returns rows changed. */
    async replay(integrationId: string, id: string, now: Date): Promise<number> {
      return (
        await db.integrationDelivery.updateMany({
          where: { ...org, integrationId, id, status: { in: ["DEAD", "FAILED"] } },
          data: { status: "PENDING", attempts: 0, nextAttemptAt: now, lockedUntil: null, lastErrorCode: null, lastErrorSummary: null },
        })
      ).count;
    },
    findForLog: (integrationId: string, id: string) =>
      db.integrationDelivery.findFirst({ where: { ...org, integrationId, id }, select: { id: true, outboxEventId: true, outboxEvent: { select: { eventType: true } } } }),
  };
}

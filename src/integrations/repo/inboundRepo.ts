// InboundEvent persistence. The state machine:
//
//   RECEIVED --claim--> PROCESSING --ok--> SUCCEEDED
//                          |--permanent problem--> REJECTED   (not retried; replayable by an admin)
//                          |--transient problem--> FAILED --(backoff)--> claim again ... --> DEAD (attempts exhausted)
//   PROCESSING with an expired lease -> reaped to FAILED/DEAD (counts as an attempt)
//
// `attempts` counts STARTED attempts (incremented at claim). Every transition out of PROCESSING is guarded by
// (status = PROCESSING AND attempts = the claimed attempt), so a worker that lost its lease can never overwrite
// the outcome of the worker that took over.
import type { Prisma } from "@/generated/prisma/client";
import type { TenantContext } from "@/modules/tenancy";
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";
import { DEFAULT_MAX_ATTEMPTS, LEASE_SECONDS } from "../core/retry";

export interface ClaimedInbound {
  id: string;
  organizationId: string;
  integrationId: string;
  externalEventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  correlationId: string;
}

export interface ReapedRow {
  id: string;
  organizationId: string;
  integrationId: string;
  status: "FAILED" | "DEAD";
  attempts: number;
  externalEventId: string;
  eventType: string;
  correlationId: string;
}

export const inboundRepo = {
  insertReceived: (
    data: {
      organizationId: string;
      integrationId: string;
      externalEventId: string;
      eventType: string;
      occurredAt: Date;
      payloadHash: string;
      payload: Prisma.InputJsonValue;
      correlationId: string;
    },
    db: DbClient = prisma,
  ) => db.inboundEvent.create({ data, select: { id: true } }),

  findByExternalId: (organizationId: string, integrationId: string, externalEventId: string, db: DbClient = prisma) =>
    db.inboundEvent.findUnique({
      where: { organizationId_integrationId_externalEventId: { organizationId, integrationId, externalEventId } },
      select: { id: true, payloadHash: true, status: true },
    }),

  /** Atomically claim due events of enabled, non-archived, inbound-enabled integrations. */
  async claim(now: Date, limit: number, db: DbClient = prisma): Promise<ClaimedInbound[]> {
    return db.$queryRaw<ClaimedInbound[]>`
      WITH due AS (
        SELECT e."id" FROM "InboundEvent" e
        JOIN "Integration" i ON i."organizationId" = e."organizationId" AND i."id" = e."integrationId"
        WHERE e."status" IN ('RECEIVED', 'FAILED') AND e."nextAttemptAt" <= ${now}::timestamptz
          AND i."enabled" AND i."inboundEnabled" AND i."archivedAt" IS NULL
        ORDER BY e."nextAttemptAt", e."receivedAt", e."id"
        LIMIT ${limit}::int
        FOR UPDATE OF e SKIP LOCKED)
      UPDATE "InboundEvent" e SET
        "status" = 'PROCESSING', "attempts" = e."attempts" + 1,
        "lockedUntil" = ${now}::timestamptz + make_interval(secs => ${LEASE_SECONDS}::double precision),
        "updatedAt" = ${now}::timestamptz
      FROM due WHERE e."id" = due."id"
      RETURNING e."id", e."organizationId", e."integrationId", e."externalEventId", e."eventType", e."payload", e."attempts", e."correlationId"`;
  },

  /** Events whose worker vanished: back to FAILED (retry now) or DEAD when attempts are exhausted. */
  async reapExpired(now: Date, db: DbClient = prisma): Promise<ReapedRow[]> {
    return db.$queryRaw<ReapedRow[]>`
      UPDATE "InboundEvent" e SET
        "status" = CASE WHEN e."attempts" >= COALESCE((i."config"->>'maxAttempts')::int, ${DEFAULT_MAX_ATTEMPTS}::int) THEN 'DEAD'::"InboundEventStatus" ELSE 'FAILED'::"InboundEventStatus" END,
        "lockedUntil" = NULL, "nextAttemptAt" = ${now}::timestamptz,
        "lastErrorCode" = 'LEASE_EXPIRED', "lastErrorSummary" = 'Processing did not finish before the lease expired',
        "processedAt" = CASE WHEN e."attempts" >= COALESCE((i."config"->>'maxAttempts')::int, ${DEFAULT_MAX_ATTEMPTS}::int) THEN ${now}::timestamptz ELSE NULL END,
        "updatedAt" = ${now}::timestamptz
      FROM "Integration" i
      WHERE i."organizationId" = e."organizationId" AND i."id" = e."integrationId"
        AND e."status" = 'PROCESSING' AND e."lockedUntil" < ${now}::timestamptz
      RETURNING e."id", e."organizationId", e."integrationId", e."status"::text AS "status", e."attempts", e."externalEventId", e."eventType", e."correlationId"`;
  },

  /** Guarded transitions out of PROCESSING; each returns the number of rows changed (0 = lease lost). */
  async markSucceeded(db: DbClient, id: string, attempts: number, result: { resultType: string; resultId: string }, now: Date): Promise<number> {
    return (
      await db.inboundEvent.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "SUCCEEDED", lockedUntil: null, resultType: result.resultType, resultId: result.resultId, lastErrorCode: null, lastErrorSummary: null, processedAt: now },
      })
    ).count;
  },
  async markRejected(id: string, attempts: number, code: string, summary: string, now: Date, db: DbClient = prisma): Promise<number> {
    return (
      await db.inboundEvent.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "REJECTED", lockedUntil: null, lastErrorCode: code, lastErrorSummary: summary, processedAt: now },
      })
    ).count;
  },
  async markFailed(id: string, attempts: number, code: string, summary: string, nextAttemptAt: Date, db: DbClient = prisma): Promise<number> {
    return (
      await db.inboundEvent.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "FAILED", lockedUntil: null, lastErrorCode: code, lastErrorSummary: summary, nextAttemptAt },
      })
    ).count;
  },
  async markDead(id: string, attempts: number, code: string, summary: string, now: Date, db: DbClient = prisma): Promise<number> {
    return (
      await db.inboundEvent.updateMany({
        where: { id, status: "PROCESSING", attempts },
        data: { status: "DEAD", lockedUntil: null, lastErrorCode: code, lastErrorSummary: summary, processedAt: now },
      })
    ).count;
  },
};

const listSelect = {
  id: true,
  externalEventId: true,
  eventType: true,
  occurredAt: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  resultType: true,
  resultId: true,
  lastErrorCode: true,
  lastErrorSummary: true,
  correlationId: true,
  receivedAt: true,
  processedAt: true,
} satisfies Prisma.InboundEventSelect;

/** Tenant-scoped reads and the admin replay. The raw payload is selected only by `get`. */
export function inboundAdminRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  return {
    list: (integrationId: string, filter: { status?: Prisma.InboundEventWhereInput["status"] }, limit: number) =>
      db.inboundEvent.findMany({
        where: { ...org, integrationId, ...(filter.status ? { status: filter.status } : {}) },
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        take: limit,
        select: listSelect,
      }),
    get: (integrationId: string, id: string, withPayload: boolean) =>
      db.inboundEvent.findFirst({ where: { ...org, integrationId, id }, select: { ...listSelect, ...(withPayload ? { payload: true } : {}) } }),
    /** Put a REJECTED/DEAD/FAILED event back in the queue with a fresh attempt budget. Guarded: returns rows changed. */
    async replay(integrationId: string, id: string, now: Date): Promise<number> {
      return (
        await db.inboundEvent.updateMany({
          where: { ...org, integrationId, id, status: { in: ["REJECTED", "DEAD", "FAILED"] } },
          data: { status: "RECEIVED", attempts: 0, nextAttemptAt: now, lockedUntil: null, lastErrorCode: null, lastErrorSummary: null, processedAt: null },
        })
      ).count;
    },
    findForLog: (integrationId: string, id: string) =>
      db.inboundEvent.findFirst({ where: { ...org, integrationId, id }, select: { id: true, externalEventId: true, eventType: true, correlationId: true } }),
  };
}

export type InboundListRow = Prisma.InboundEventGetPayload<{ select: typeof listSelect }>;

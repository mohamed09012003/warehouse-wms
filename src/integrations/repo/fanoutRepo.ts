// System-level (cross-tenant) access used by the worker to fan outbox events out to integrations and to
// purge old rows. The write side of OutboxEvent is modules/outbox; this is the only reader/marker/purger.
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";

export interface UnfannedEvent {
  id: string;
  organizationId: string;
  eventType: string;
}

export interface OutboundIntegration {
  id: string;
  organizationId: string;
  provider: string;
  config: unknown;
}

export const fanoutRepo = {
  /** Lock the oldest events that have not been fanned out (other workers skip locked rows). */
  async lockUnfanned(tx: DbClient, limit: number): Promise<UnfannedEvent[]> {
    return tx.$queryRaw<UnfannedEvent[]>`
      SELECT "id", "organizationId", "eventType" FROM "OutboxEvent"
      WHERE "fannedOutAt" IS NULL ORDER BY "seq" LIMIT ${limit}::int FOR UPDATE SKIP LOCKED`;
  },

  /** Integrations of an organization that should receive deliveries (enabled, outbound, not archived; a paused one still queues). */
  outboundIntegrations: (tx: DbClient, organizationId: string): Promise<OutboundIntegration[]> =>
    tx.integration.findMany({
      where: { organizationId, enabled: true, outboundEnabled: true, archivedAt: null },
      select: { id: true, organizationId: true, provider: true, config: true },
    }),

  /** One delivery per (integration, event); a repeated fan-out is a no-op thanks to the unique index. */
  async createDeliveries(tx: DbClient, rows: { organizationId: string; integrationId: string; outboxEventId: string }[], now: Date): Promise<number> {
    if (rows.length === 0) return 0;
    return (await tx.integrationDelivery.createMany({ data: rows.map((r) => ({ ...r, nextAttemptAt: now })), skipDuplicates: true })).count;
  },

  async markFannedOut(tx: DbClient, ids: string[], now: Date): Promise<void> {
    if (ids.length === 0) return;
    await tx.outboxEvent.updateMany({ where: { id: { in: ids }, fannedOutAt: null }, data: { fannedOutAt: now } });
  },

  /**
   * Retention: finished deliveries older than the cutoffs go first (SUCCEEDED earlier than DEAD, which is kept
   * longer for diagnosis/replay), then fanned-out events that no delivery references any more.
   * Only terminal rows are ever removed: PENDING/FAILED/PROCESSING deliveries (and their events) are never purged.
   */
  async purge(now: Date, retention: { succeededMs: number; deadMs: number; eventMs: number }, limit: number, db: DbClient = prisma): Promise<{ deliveries: number; events: number }> {
    const succeededBefore = new Date(now.getTime() - retention.succeededMs);
    const deadBefore = new Date(now.getTime() - retention.deadMs);
    const eventBefore = new Date(now.getTime() - retention.eventMs);
    const deliveries = await db.$executeRaw`
      DELETE FROM "IntegrationDelivery" WHERE "id" IN (
        SELECT "id" FROM "IntegrationDelivery"
        WHERE ("status" = 'SUCCEEDED' AND "updatedAt" < ${succeededBefore}::timestamptz)
           OR ("status" = 'DEAD' AND "updatedAt" < ${deadBefore}::timestamptz)
        LIMIT ${limit}::int)`;
    const events = await db.$executeRaw`
      DELETE FROM "OutboxEvent" e WHERE e."id" IN (
        SELECT o."id" FROM "OutboxEvent" o
        WHERE o."fannedOutAt" IS NOT NULL AND o."fannedOutAt" < ${eventBefore}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM "IntegrationDelivery" d WHERE d."outboxEventId" = o."id")
        LIMIT ${limit}::int)`;
    return { deliveries, events };
  },
};

/** Retention periods (documented in docs/integrations.md). */
export const RETENTION = {
  succeededMs: 7 * 24 * 3600 * 1000,
  deadMs: 30 * 24 * 3600 * 1000,
  eventMs: 7 * 24 * 3600 * 1000,
} as const;

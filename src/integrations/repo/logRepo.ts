// Append-only integration log (database trigger). Only code, ids, counts and short redacted summaries go in.
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";
import type { TenantContext } from "@/modules/tenancy";
import { redactText } from "@/lib/redact";

export type LogStatus =
  | "RECEIVED"
  | "DUPLICATE"
  | "CONFLICT"
  | "SUCCEEDED"
  | "RETRY_SCHEDULED"
  | "REJECTED"
  | "DEAD"
  | "REPLAYED"
  | "PAUSED"
  | "RESUMED"
  | "TEST_SUCCEEDED"
  | "TEST_FAILED"
  | "LEASE_EXPIRED";

export interface LogEntry {
  organizationId: string;
  integrationId: string;
  direction: "INBOUND" | "OUTBOUND";
  provider: string;
  eventId?: string | null;
  eventType?: string | null;
  inboundEventId?: string | null;
  deliveryId?: string | null;
  correlationId: string;
  status: LogStatus;
  attempt?: number;
  httpStatus?: number | null;
  durationMs?: number | null;
  safeSummary: string;
}

export async function appendLog(entry: LogEntry, db: DbClient = prisma): Promise<void> {
  await db.integrationLog.create({
    data: {
      organizationId: entry.organizationId,
      integrationId: entry.integrationId,
      direction: entry.direction,
      provider: entry.provider,
      eventId: entry.eventId ?? null,
      eventType: entry.eventType ?? null,
      inboundEventId: entry.inboundEventId ?? null,
      deliveryId: entry.deliveryId ?? null,
      correlationId: entry.correlationId,
      status: entry.status,
      attempt: entry.attempt ?? 0,
      httpStatus: entry.httpStatus ?? null,
      durationMs: entry.durationMs ?? null,
      safeSummary: redactText(entry.safeSummary, 300),
    },
  });
}

export function logRepo(ctx: TenantContext, db: DbClient = prisma) {
  return {
    list: (integrationId: string, limit: number) =>
      db.integrationLog.findMany({
        where: { organizationId: ctx.organizationId, integrationId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      }),
  };
}

// Write side of the outbox. Always takes a transaction client: an event must commit or roll back
// together with the business change that caused it. The fan-out/purge side lives in the
// integrations worker repositories (cross-tenant, system level).
import type { Tx } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";

export function outboxRepo(ctx: TenantContext, tx: Tx) {
  return {
    insert: (data: { eventType: string; schemaVersion: number; payload: object }) =>
      tx.outboxEvent.create({
        data: { organizationId: ctx.organizationId, eventType: data.eventType, schemaVersion: data.schemaVersion, payload: data.payload },
        select: { id: true },
      }),
  };
}

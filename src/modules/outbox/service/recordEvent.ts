import { ValidationError } from "@/lib/errors";
import { findSecretLookingKeys } from "@/lib/redact";
import type { TenantContext } from "@/modules/tenancy";
import type { Tx } from "@/server/db";
import { MAX_OUTBOX_PAYLOAD_BYTES, OUTBOX_SCHEMA_VERSION, isOutboxEventType, type OutboxEventInput } from "../domain/events";
import { outboxRepo } from "../repo/outboxRepo";

/**
 * Record a domain event in the caller's transaction. Internal: no permission check and no HTTP route.
 * A single INSERT; if the surrounding transaction rolls back, so does the event. The organization
 * always comes from the TenantContext.
 */
export async function recordEvent(tx: Tx, ctx: TenantContext, event: OutboxEventInput): Promise<string> {
  if (!isOutboxEventType(event.type)) throw new ValidationError(`Unknown outbox event type "${event.type}"`);
  const bytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
  if (bytes > MAX_OUTBOX_PAYLOAD_BYTES) throw new ValidationError("Outbox event payload is too large");
  // Defence in depth: event payloads never carry credentials.
  if (findSecretLookingKeys(event.payload).length > 0) throw new ValidationError("Outbox event payload contains a secret-looking field");
  const row = await outboxRepo(ctx, tx).insert({ eventType: event.type, schemaVersion: OUTBOX_SCHEMA_VERSION, payload: event.payload });
  return row.id;
}

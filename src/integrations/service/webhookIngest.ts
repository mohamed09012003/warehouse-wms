// The public inbound webhook: POST /api/webhooks/{publicId}.
//
// ORDER OF WORK (the request never runs business logic):
//   1. size gate (256 KiB)               -> 413
//   2. look the integration up by publicId (the ONLY lookup key; never an org slug)
//   3. verify the signature (adapter)    -> 401, identical for unknown id / disabled / archived / bad signature /
//                                           stale timestamp / missing secret: the caller learns nothing
//   4. validate the envelope             -> 400
//   5. persist an InboundEvent           -> 202 (new), 200 (same event id + same payload = duplicate),
//                                           409 (same event id, different payload)
// Processing happens later in the worker. Once an envelope is persisted, semantic/business problems become
// REJECTED events and never cause webhook retries.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { redactText } from "@/lib/redact";
import { logSafe } from "../core/logger";
import { getProvider } from "../core/registry";
import { systemIntegrationRepo } from "../repo/integrationRepo";
import { inboundRepo } from "../repo/inboundRepo";
import type { JsonInput } from "../repo/json";
import { appendLog } from "../repo/logRepo";
import { secretStore } from "../secrets/secretStore";
import { VaultError } from "../secrets/vault";

export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
const PUBLIC_ID = /^[A-Za-z0-9_-]{22,64}$/;

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

const err = (status: number, code: string, message: string): WebhookResponse => ({ status, body: { error: { code, message } } });
/** The single answer for every authentication problem. */
const UNAUTHENTICATED = () => err(401, "AUTHENTICATION_REQUIRED", "Authentication failed");

/** Read the body as UTF-8 text, or null when it exceeds `max` bytes (checked while streaming). */
export async function readBodyLimited(request: Request, max: number): Promise<{ text: string } | { tooLarge: true } | { invalid: true }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { invalid: true };
  }
}

function correlationIdOf(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[A-Za-z0-9._-]{8,64}$/.test(supplied) ? supplied : randomUUID();
}

export async function ingestWebhook(publicId: string, request: Request, now: Date = new Date()): Promise<WebhookResponse> {
  const body = await readBodyLimited(request, MAX_WEBHOOK_BODY_BYTES);
  if ("tooLarge" in body) return err(413, "PAYLOAD_TOO_LARGE", "The request body is larger than 256 KiB");

  const integration = PUBLIC_ID.test(publicId) ? await systemIntegrationRepo.findByPublicId(publicId) : null;
  const adapter = integration && integration.enabled && integration.inboundEnabled && !integration.archivedAt ? getProvider(integration.provider)?.inbound : undefined;
  if (!integration || !adapter) {
    // Do comparable work so unknown/disabled integrations are not distinguishable by timing.
    createHmac("sha256", "wms-dummy").update("text" in body ? body.text : "").digest();
    return UNAUTHENTICATED();
  }
  if ("invalid" in body) return UNAUTHENTICATED(); // not even valid text: cannot be a signed JSON body

  let secrets;
  try {
    secrets = await secretStore.readMany(integration.organizationId, integration.id, adapter.secretNames, now);
  } catch (error) {
    // Vault missing or a stored secret unreadable: fail closed, tell the operator in the log, tell the caller nothing.
    logSafe("error", "webhook.secret_unavailable", { integrationId: integration.id, code: error instanceof VaultError ? error.code : "ERROR" });
    return UNAUTHENTICATED();
  }

  const verified = adapter.verify({ rawBody: body.text, header: (name) => request.headers.get(name), secrets, now });
  if (verified.status === "unauthenticated") return UNAUTHENTICATED();
  if (verified.status === "malformed") return err(400, "VALIDATION_FAILED", redactText(verified.message, 200));

  const { envelope } = verified;
  const correlationId = correlationIdOf(request);
  const payloadHash = createHash("sha256").update(body.text).digest("hex");
  const logBase = {
    organizationId: integration.organizationId,
    integrationId: integration.id,
    direction: "INBOUND" as const,
    provider: integration.provider,
    eventId: envelope.eventId,
    eventType: envelope.type,
    correlationId,
  };

  try {
    const created = await inboundRepo.insertReceived({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      externalEventId: envelope.eventId,
      eventType: envelope.type,
      occurredAt: envelope.occurredAt,
      payloadHash,
      payload: { eventId: envelope.eventId, type: envelope.type, occurredAt: envelope.occurredAt.toISOString(), data: envelope.data } as JsonInput,
      correlationId,
    });
    await appendLog({ ...logBase, inboundEventId: created.id, status: "RECEIVED", safeSummary: "Event accepted for processing" }).catch(() => undefined);
    logSafe("info", "webhook.received", { integrationId: integration.id, eventId: envelope.eventId, eventType: envelope.type, inboundEventId: created.id, correlationId });
    return { status: 202, body: { status: "accepted", eventId: envelope.eventId } };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "P2002") {
      const existing = await inboundRepo.findByExternalId(integration.organizationId, integration.id, envelope.eventId);
      if (existing && existing.payloadHash === payloadHash) {
        await appendLog({ ...logBase, inboundEventId: existing.id, status: "DUPLICATE", safeSummary: "Duplicate delivery of an already received event" }).catch(() => undefined);
        return { status: 200, body: { status: "duplicate", eventId: envelope.eventId } };
      }
      await appendLog({ ...logBase, inboundEventId: existing?.id ?? null, status: "CONFLICT", safeSummary: "Event id was already received with a different payload" }).catch(() => undefined);
      return err(409, "CONFLICT", "This event id was already received with a different payload");
    }
    // The stored copy of a near-limit body can exceed the database size limit once normalized.
    if (code === "P2004") return err(413, "PAYLOAD_TOO_LARGE", "The event is too large to store");
    throw error;
  }
}

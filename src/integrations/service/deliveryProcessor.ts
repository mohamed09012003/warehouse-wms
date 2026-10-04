// Delivery of ONE claimed outbound delivery (called by the worker).
//
// The HTTP call happens outside any database transaction; its classified outcome is then recorded:
//   ok                  -> SUCCEEDED
//   retry (network, timeout, 5xx, 408, 429, Retry-After honoured and capped) -> FAILED + backoff, DEAD after max attempts
//   fail (other 4xx, redirect, policy/config problem)                        -> DEAD at once (replayable by an admin)
// The event id is stable across attempts; each attempt gets a fresh delivery id. Delivery is at-least-once.
import { randomUUID } from "node:crypto";
import { VaultError } from "../secrets/vault";
import { secretStore } from "../secrets/secretStore";
import { logSafe } from "../core/logger";
import { getProvider } from "../core/registry";
import { decideAfterTransientFailure, effectiveMaxAttempts } from "../core/retry";
import type { DeliveryOutcome } from "../core/types";
import { deliveryRepo, type ClaimedDelivery } from "../repo/deliveryRepo";
import { systemIntegrationRepo } from "../repo/integrationRepo";
import { appendLog } from "../repo/logRepo";
import { recordFailureOutcome, recordSuccessOutcome } from "./health";
import type { WorkerDeps } from "./workerDeps";

export type DeliveryResult = "succeeded" | "failed" | "dead" | "lease_lost";

export async function processDelivery(claimed: ClaimedDelivery, deps: WorkerDeps): Promise<DeliveryResult> {
  const correlationId = randomUUID();
  const integration = await systemIntegrationRepo.findById(claimed.integrationId);
  const adapter = integration ? getProvider(integration.provider)?.outbound : undefined;
  const event = await deliveryRepo.loadEvent(claimed.organizationId, claimed.outboxEventId);
  const deliveryAttemptId = randomUUID();

  let outcome: DeliveryOutcome;
  if (!integration || !adapter || !event || integration.organizationId !== claimed.organizationId || integration.archivedAt) {
    outcome = { kind: "fail", code: "INTEGRATION_UNAVAILABLE", summary: "The integration, its adapter or the event is not available" };
  } else {
    try {
      const secrets = await secretStore.readMany(integration.organizationId, integration.id, adapter.secretNames, deps.now());
      outcome = await adapter.deliver(
        {
          integration: { id: integration.id, organizationId: integration.organizationId, provider: integration.provider, config: integration.config },
          secrets,
          http: deps.http,
          now: deps.now(),
          attempt: claimed.attempts,
          deliveryId: deliveryAttemptId,
        },
        { id: event.id, type: event.eventType, schemaVersion: event.schemaVersion, occurredAt: event.occurredAt.toISOString(), seq: String(event.seq), payload: event.payload },
      );
    } catch (error) {
      // Adapters should classify their own failures; anything that still escapes is reduced to a code.
      outcome =
        error instanceof VaultError
          ? { kind: "fail", code: error.code, summary: "A stored secret could not be read" }
          : { kind: "retry", code: "ADAPTER_ERROR", summary: "The adapter failed unexpectedly" };
    }
  }

  const now = deps.now();
  const httpStatus = "httpStatus" in outcome ? (outcome.httpStatus ?? null) : null;
  const durationMs = "durationMs" in outcome ? (outcome.durationMs ?? null) : null;
  const base = {
    organizationId: claimed.organizationId,
    integrationId: claimed.integrationId,
    direction: "OUTBOUND" as const,
    provider: integration?.provider ?? "unknown",
    eventId: claimed.outboxEventId,
    eventType: event?.eventType ?? null,
    deliveryId: claimed.id,
    correlationId,
    attempt: claimed.attempts,
    httpStatus,
    durationMs,
  };
  const logFields = { deliveryId: claimed.id, integrationId: claimed.integrationId, eventId: claimed.outboxEventId, attempt: claimed.attempts, httpStatus: httpStatus ?? undefined, durationMs: durationMs ?? undefined, correlationId };

  if (outcome.kind === "ok") {
    if ((await deliveryRepo.markSucceeded(claimed.id, claimed.attempts, httpStatus, now)) !== 1) return "lease_lost";
    await appendLog({ ...base, status: "SUCCEEDED", safeSummary: `Delivered (HTTP ${httpStatus ?? "n/a"})` });
    logSafe("info", "delivery.succeeded", logFields);
    if (integration) await recordSuccessOutcome(integration, "OUTBOUND", now);
    return "succeeded";
  }

  const maxAttempts = effectiveMaxAttempts((integration?.config as { maxAttempts?: unknown } | null)?.maxAttempts);
  const decision: ReturnType<typeof decideAfterTransientFailure> =
    outcome.kind === "fail" ? { status: "DEAD" } : decideAfterTransientFailure(claimed.attempts, maxAttempts, now, outcome.retryAfterMs);
  const changed =
    decision.status === "DEAD"
      ? await deliveryRepo.markDead(claimed.id, claimed.attempts, outcome.code, outcome.summary, httpStatus)
      : await deliveryRepo.markFailed(claimed.id, claimed.attempts, outcome.code, outcome.summary, httpStatus, decision.nextAttemptAt);
  if (changed !== 1) return "lease_lost";
  await appendLog({ ...base, status: decision.status === "DEAD" ? "DEAD" : "RETRY_SCHEDULED", safeSummary: `${outcome.code}: ${outcome.summary}` });
  logSafe("warn", decision.status === "DEAD" ? "delivery.dead" : "delivery.retry_scheduled", { ...logFields, code: outcome.code });
  if (integration) await recordFailureOutcome(integration, "OUTBOUND", { provider: integration.provider, correlationId, summary: `${outcome.code}: ${outcome.summary}` }, now);
  return decision.status === "DEAD" ? "dead" : "failed";
}

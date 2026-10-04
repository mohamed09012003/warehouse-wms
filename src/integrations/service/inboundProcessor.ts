// Processing of ONE claimed inbound event (called by the worker, never from an HTTP request).
//
//   validate the handler payload -> in ONE transaction: run the handler (which calls core services and
//   writes ExternalRef) + mark the event SUCCEEDED. Any failure rolls the handler's work back; the outcome
//   is then recorded outside the transaction:
//     permanent problem (bad data, unknown reference, rule violation)  -> REJECTED (never retried)
//     transient problem                                                -> FAILED + backoff, DEAD after max attempts
//     lease lost to another worker                                     -> nothing recorded
import { performance } from "node:perf_hooks";
import { withTransaction } from "@/server/db";
import { classifyInboundError, InboundRejectError, LeaseLostError, summarizeZodError } from "../core/errors";
import { logSafe } from "../core/logger";
import { getProvider } from "../core/registry";
import { decideAfterTransientFailure, effectiveMaxAttempts } from "../core/retry";
import { systemIntegrationRepo } from "../repo/integrationRepo";
import { inboundRepo, type ClaimedInbound } from "../repo/inboundRepo";
import { appendLog, type LogStatus } from "../repo/logRepo";
import { resolveIntegrationContext } from "./context";
import { recordFailureOutcome, recordSuccessOutcome } from "./health";
import type { WorkerDeps } from "./workerDeps";

export type InboundOutcome = "succeeded" | "rejected" | "failed" | "dead" | "lease_lost";

export async function processInboundEvent(claimed: ClaimedInbound, deps: WorkerDeps): Promise<InboundOutcome> {
  const started = performance.now();
  const duration = () => Math.round(performance.now() - started);
  const integration = await systemIntegrationRepo.findById(claimed.integrationId);
  const provider = integration ? getProvider(integration.provider) : undefined;

  const log = (status: LogStatus, summary: string) =>
    integration
      ? appendLog({
          organizationId: claimed.organizationId,
          integrationId: claimed.integrationId,
          direction: "INBOUND",
          provider: integration.provider,
          eventId: claimed.externalEventId,
          eventType: claimed.eventType,
          inboundEventId: claimed.id,
          correlationId: claimed.correlationId,
          status,
          attempt: claimed.attempts,
          durationMs: duration(),
          safeSummary: summary,
        })
      : Promise.resolve();

  const reject = async (code: string, summary: string): Promise<InboundOutcome> => {
    if ((await inboundRepo.markRejected(claimed.id, claimed.attempts, code, summary, deps.now())) !== 1) return "lease_lost";
    await log("REJECTED", `${code}: ${summary}`);
    logSafe("warn", "inbound.rejected", { inboundEventId: claimed.id, integrationId: claimed.integrationId, code, attempt: claimed.attempts, correlationId: claimed.correlationId });
    return "rejected";
  };

  const transient = async (code: string, summary: string): Promise<InboundOutcome> => {
    const now = deps.now();
    const decision = decideAfterTransientFailure(claimed.attempts, effectiveMaxAttempts((integration?.config as { maxAttempts?: unknown } | null)?.maxAttempts), now);
    const changed =
      decision.status === "DEAD"
        ? await inboundRepo.markDead(claimed.id, claimed.attempts, code, summary, now)
        : await inboundRepo.markFailed(claimed.id, claimed.attempts, code, summary, decision.nextAttemptAt);
    if (changed !== 1) return "lease_lost";
    await log(decision.status === "DEAD" ? "DEAD" : "RETRY_SCHEDULED", `${code}: ${summary}`);
    logSafe("warn", decision.status === "DEAD" ? "inbound.dead" : "inbound.retry_scheduled", {
      inboundEventId: claimed.id,
      integrationId: claimed.integrationId,
      code,
      attempt: claimed.attempts,
      correlationId: claimed.correlationId,
    });
    if (integration) await recordFailureOutcome(integration, "INBOUND", { provider: integration.provider, correlationId: claimed.correlationId, summary: `${code}: ${summary}` }, now);
    return decision.status === "DEAD" ? "dead" : "failed";
  };

  // Integration vanished, was archived or is not usable any more: give the attempt back as a transient failure.
  if (!integration || integration.organizationId !== claimed.organizationId || integration.archivedAt || !integration.enabled || !provider?.inbound) {
    return transient("INTEGRATION_UNAVAILABLE", "The integration is not available for processing");
  }

  const handler = provider.inbound.handlers[claimed.eventType];
  if (!handler) return reject("UNSUPPORTED_EVENT_TYPE", `Event type ${claimed.eventType} is not supported`);

  const envelope = claimed.payload as { data?: unknown } | null;
  const parsed = handler.schema.safeParse(envelope?.data);
  if (!parsed.success) return reject("INVALID_PAYLOAD", summarizeZodError(parsed.error));

  try {
    const ctx = resolveIntegrationContext(integration);
    const adapterIntegration = { id: integration.id, organizationId: integration.organizationId, provider: integration.provider, config: integration.config };
    const result = await withTransaction(async (tx) => {
      const handled = await handler.handle({ ctx, tx, integration: adapterIntegration, inboundEventId: claimed.id }, parsed.data);
      // Guarded: if the lease was lost the whole attempt (including the handler's writes) rolls back.
      if ((await inboundRepo.markSucceeded(tx, claimed.id, claimed.attempts, handled, deps.now())) !== 1) throw new LeaseLostError();
      return handled;
    });
    await log("SUCCEEDED", `${result.resultType} ${result.resultId}`);
    logSafe("info", "inbound.succeeded", { inboundEventId: claimed.id, integrationId: claimed.integrationId, eventType: claimed.eventType, attempt: claimed.attempts, durationMs: duration(), correlationId: claimed.correlationId });
    await recordSuccessOutcome(integration, "INBOUND", deps.now());
    return "succeeded";
  } catch (error) {
    const failure = classifyInboundError(error);
    if (failure.kind === "lease_lost") return "lease_lost";
    if (failure.kind === "rejected") return reject(failure.code, failure.summary);
    return transient(failure.code, failure.summary);
  }
}

// InboundRejectError is thrown by handlers; re-exported for adapters that import from here.
export { InboundRejectError };

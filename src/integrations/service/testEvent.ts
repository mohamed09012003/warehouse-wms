// "Test connection": send a signed `integration.test` event to the integration's target through the same
// adapter and SafeHttpClient as real deliveries. It is synchronous (one request, 10 s timeout), writes no
// delivery row and no outbox event, and records a log row, a health update and nothing else.
import { randomUUID } from "node:crypto";
import { InvalidStateError, ValidationError } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import type { DeliveryOutcome } from "../core/types";
import { appendLog } from "../repo/logRepo";
import { secretStore } from "../secrets/secretStore";
import { VaultError } from "../secrets/vault";
import { recordFailureOutcome, recordSuccessOutcome } from "./health";
import { providerOrThrow, requireIntegration, secretNamesOf } from "./integrations";
import { defaultWorkerDeps, type WorkerDeps } from "./workerDeps";
import type { TestResultDto } from "../types";

export async function testIntegration(ctx: TenantContext, integrationId: string, deps: WorkerDeps = defaultWorkerDeps()): Promise<TestResultDto> {
  requirePermission(ctx, "integrations.manage");
  const integration = await requireIntegration(ctx, integrationId);
  if (integration.archivedAt) throw new InvalidStateError("An archived integration cannot be tested");
  const provider = providerOrThrow(integration.provider);
  if (!provider.outbound) throw new ValidationError("This provider cannot send events, so there is nothing to test");

  const meta = await secretStore.metadata(ctx.organizationId, integration.id, secretNamesOf(provider));
  const problems = provider.readiness({ inboundEnabled: false, outboundEnabled: true, config: integration.config }, new Set(meta.filter((m) => m.isSet).map((m) => m.name)));
  if (problems.length > 0) throw new ValidationError(`Cannot test yet: ${problems.join("; ")}`);

  const now = deps.now();
  const correlationId = randomUUID();
  const eventId = randomUUID();
  let outcome: DeliveryOutcome;
  try {
    const secrets = await secretStore.readMany(ctx.organizationId, integration.id, provider.outbound.secretNames, now);
    outcome = await provider.outbound.deliver(
      {
        integration: { id: integration.id, organizationId: integration.organizationId, provider: integration.provider, config: integration.config },
        secrets,
        http: deps.http,
        now,
        attempt: 1,
        deliveryId: randomUUID(),
      },
      { id: eventId, type: "integration.test", schemaVersion: 1, occurredAt: now.toISOString(), seq: "0", payload: { message: "WMS connection test" } },
    );
  } catch (error) {
    outcome =
      error instanceof VaultError
        ? { kind: "fail", code: error.code, summary: "A stored secret could not be read" }
        : { kind: "retry", code: "ADAPTER_ERROR", summary: "The adapter failed unexpectedly" };
  }

  const httpStatus = outcome.httpStatus ?? null;
  const durationMs = outcome.durationMs ?? null;
  const failure = outcome.kind === "ok" ? null : outcome;
  const ok = failure === null;
  const summary = failure ? failure.summary : `Target accepted the test event (HTTP ${httpStatus ?? "n/a"})`;
  await appendLog({
    organizationId: ctx.organizationId,
    integrationId: integration.id,
    direction: "OUTBOUND",
    provider: integration.provider,
    eventId,
    eventType: "integration.test",
    correlationId,
    status: ok ? "TEST_SUCCEEDED" : "TEST_FAILED",
    attempt: 1,
    httpStatus,
    durationMs,
    safeSummary: failure ? `${failure.code}: ${summary}` : summary,
  });
  if (!failure) await recordSuccessOutcome(integration, "OUTBOUND", deps.now());
  else await recordFailureOutcome(integration, "OUTBOUND", { provider: integration.provider, correlationId, summary: `${failure.code}: ${summary}` }, deps.now());
  return { ok, httpStatus, code: failure?.code ?? null, summary, durationMs };
}

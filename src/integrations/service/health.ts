// Shared bookkeeping after an outcome. Health is tracked PER DIRECTION and independently:
//   inbound  outcomes update only the inbound columns,
//   outbound outcomes update only the outbound columns, and only outbound failures can trip the circuit breaker.
// When the breaker trips, one PAUSED log row is written. Only safe summaries are stored.
import { redactText } from "@/lib/redact";
import { logSafe } from "../core/logger";
import { systemIntegrationRepo } from "../repo/integrationRepo";
import { appendLog } from "../repo/logRepo";

export type Direction = "INBOUND" | "OUTBOUND";

export async function recordSuccessOutcome(integration: { id: string }, direction: Direction, now: Date): Promise<void> {
  if (direction === "INBOUND") await systemIntegrationRepo.recordInboundSuccess(integration.id, now);
  else await systemIntegrationRepo.recordOutboundSuccess(integration.id, now);
}

export async function recordFailureOutcome(
  integration: { id: string; organizationId: string; provider: string },
  direction: Direction,
  detail: { provider: string; correlationId: string; summary: string },
  now: Date,
): Promise<void> {
  const summary = redactText(detail.summary, 300);
  if (direction === "INBOUND") {
    await systemIntegrationRepo.recordInboundFailure(integration.id, summary, now);
    return; // inbound failures never pause outbound delivery
  }
  const { newlyPaused, consecutiveFailures } = await systemIntegrationRepo.recordOutboundFailure(integration.id, summary, now);
  if (newlyPaused) {
    await appendLog({
      organizationId: integration.organizationId,
      integrationId: integration.id,
      direction: "OUTBOUND",
      provider: detail.provider,
      correlationId: detail.correlationId,
      status: "PAUSED",
      safeSummary: `Outbound delivery paused automatically after ${consecutiveFailures} consecutive outbound failures`,
    });
    logSafe("warn", "outbound.paused", { integrationId: integration.id, count: consecutiveFailures, correlationId: detail.correlationId });
  }
}

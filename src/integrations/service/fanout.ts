// Outbox fan-out: turn each not-yet-fanned-out OutboxEvent into one IntegrationDelivery per subscribed,
// enabled outbound integration of the same organization, then mark the event fanned out.
//
// One transaction per batch. Events are locked with SKIP LOCKED (another worker takes the rest); the
// unique (integrationId, outboxEventId) index makes a repeated fan-out a no-op. There is no cursor: the
// `fannedOutAt IS NULL` marker is the only state, so out-of-order commits of `seq` cannot skip an event.
// An integration receives events that are fanned out while it is enabled; a PAUSED (circuit breaker)
// integration still queues deliveries so nothing is lost.
import { withTransaction } from "@/server/db";
import { getProvider } from "../core/registry";
import { fanoutRepo, type OutboundIntegration } from "../repo/fanoutRepo";
import type { WorkerDeps } from "./workerDeps";

export async function fanOutOutbox(deps: WorkerDeps, limit = 100): Promise<{ events: number; deliveries: number }> {
  return withTransaction(async (tx) => {
    const events = await fanoutRepo.lockUnfanned(tx, limit);
    if (events.length === 0) return { events: 0, deliveries: 0 };
    const now = deps.now();

    const integrationsByOrg = new Map<string, OutboundIntegration[]>();
    const rows: { organizationId: string; integrationId: string; outboxEventId: string }[] = [];
    for (const event of events) {
      let integrations = integrationsByOrg.get(event.organizationId);
      if (!integrations) {
        integrations = await fanoutRepo.outboundIntegrations(tx, event.organizationId);
        integrationsByOrg.set(event.organizationId, integrations);
      }
      for (const integration of integrations) {
        const adapter = getProvider(integration.provider)?.outbound;
        if (adapter?.subscribes(integration.config, event.eventType)) {
          rows.push({ organizationId: event.organizationId, integrationId: integration.id, outboxEventId: event.id });
        }
      }
    }
    const deliveries = await fanoutRepo.createDeliveries(tx, rows, now);
    await fanoutRepo.markFannedOut(tx, events.map((e) => e.id), now);
    return { events: events.length, deliveries };
  });
}

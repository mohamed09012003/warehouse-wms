// One pass of the integration worker. Tests call runOnce() directly; `npm run worker` calls it in a loop.
//
//   1. reap  : rows stuck in PROCESSING with an expired lease go back to FAILED (or DEAD when out of attempts)
//   2. process due inbound events (one claim at a time, so the 60 s lease starts when work starts)
//   3. fan out outbox events to deliveries (after step 2, so events written by inbound processing, for example
//      order.created for an imported order, are delivered in the SAME pass)
//   4. send due deliveries
//   5. purge old terminal rows (optional; no scheduler: the loop asks for it every few minutes)
// Claiming uses FOR UPDATE SKIP LOCKED, so any number of workers can run this concurrently.
import { logSafe } from "../core/logger";
import { deliveryRepo } from "../repo/deliveryRepo";
import { fanoutRepo, RETENTION } from "../repo/fanoutRepo";
import { inboundRepo } from "../repo/inboundRepo";
import { appendLog } from "../repo/logRepo";
import { systemIntegrationRepo } from "../repo/integrationRepo";
import { processDelivery, type DeliveryResult } from "../service/deliveryProcessor";
import { fanOutOutbox } from "../service/fanout";
import { recordFailureOutcome } from "../service/health";
import { processInboundEvent, type InboundOutcome } from "../service/inboundProcessor";
import { defaultWorkerDeps, type WorkerDeps } from "../service/workerDeps";

export interface RunOnceOptions {
  /** Maximum inbound events and maximum deliveries handled in this pass (each). */
  maxItems?: number;
  fanOutBatch?: number;
  purge?: boolean;
}

export interface RunSummary {
  reapedInbound: number;
  reapedDeliveries: number;
  fannedOutEvents: number;
  deliveriesCreated: number;
  inbound: Record<InboundOutcome, number>;
  deliveries: Record<DeliveryResult, number>;
  purged: { deliveries: number; events: number };
}

const emptyInbound = (): Record<InboundOutcome, number> => ({ succeeded: 0, rejected: 0, failed: 0, dead: 0, lease_lost: 0 });
const emptyDeliveries = (): Record<DeliveryResult, number> => ({ succeeded: 0, failed: 0, dead: 0, lease_lost: 0 });

export async function runOnce(deps: WorkerDeps = defaultWorkerDeps(), options: RunOnceOptions = {}): Promise<RunSummary> {
  const maxItems = options.maxItems ?? 20;
  const summary: RunSummary = {
    reapedInbound: 0,
    reapedDeliveries: 0,
    fannedOutEvents: 0,
    deliveriesCreated: 0,
    inbound: emptyInbound(),
    deliveries: emptyDeliveries(),
    purged: { deliveries: 0, events: 0 },
  };

  // 1. leases
  const reapedInbound = await inboundRepo.reapExpired(deps.now());
  const reapedDeliveries = await deliveryRepo.reapExpired(deps.now());
  summary.reapedInbound = reapedInbound.length;
  summary.reapedDeliveries = reapedDeliveries.length;
  for (const r of reapedInbound) {
    const integration = await systemIntegrationRepo.findById(r.integrationId);
    if (!integration) continue;
    await appendLog({
      organizationId: r.organizationId,
      integrationId: r.integrationId,
      direction: "INBOUND",
      provider: integration.provider,
      eventId: r.externalEventId,
      eventType: r.eventType,
      inboundEventId: r.id,
      correlationId: r.correlationId,
      status: "LEASE_EXPIRED",
      attempt: r.attempts,
      safeSummary: r.status === "DEAD" ? "Lease expired; attempts exhausted" : "Lease expired; will be retried",
    });
    await recordFailureOutcome(integration, "INBOUND", { provider: integration.provider, correlationId: r.correlationId, summary: "LEASE_EXPIRED: processing did not finish" }, deps.now());
  }
  for (const r of reapedDeliveries) {
    const integration = await systemIntegrationRepo.findById(r.integrationId);
    if (!integration) continue;
    await appendLog({
      organizationId: r.organizationId,
      integrationId: r.integrationId,
      direction: "OUTBOUND",
      provider: integration.provider,
      eventId: r.outboxEventId,
      deliveryId: r.id,
      correlationId: r.id,
      status: "LEASE_EXPIRED",
      attempt: r.attempts,
      safeSummary: r.status === "DEAD" ? "Lease expired; attempts exhausted" : "Lease expired; will be retried",
    });
    await recordFailureOutcome(integration, "OUTBOUND", { provider: integration.provider, correlationId: r.id, summary: "LEASE_EXPIRED: delivery did not finish" }, deps.now());
  }

  // 2. inbound
  for (let i = 0; i < maxItems; i++) {
    const [claimed] = await inboundRepo.claim(deps.now(), 1);
    if (!claimed) break;
    try {
      summary.inbound[await processInboundEvent(claimed, deps)]++;
    } catch (error) {
      // A bookkeeping failure must not stop the pass; the lease expires and the reaper recovers the row.
      logSafe("error", "inbound.unexpected", { inboundEventId: claimed.id, code: error instanceof Error ? error.name : "ERROR" });
    }
  }

  // 3. fan-out (repeat while full batches keep coming, bounded)
  const batch = options.fanOutBatch ?? 100;
  for (let i = 0; i < 10; i++) {
    const out = await fanOutOutbox(deps, batch);
    summary.fannedOutEvents += out.events;
    summary.deliveriesCreated += out.deliveries;
    if (out.events < batch) break;
  }

  // 4. outbound
  for (let i = 0; i < maxItems; i++) {
    const [claimed] = await deliveryRepo.claim(deps.now(), 1);
    if (!claimed) break;
    try {
      summary.deliveries[await processDelivery(claimed, deps)]++;
    } catch (error) {
      logSafe("error", "delivery.unexpected", { deliveryId: claimed.id, code: error instanceof Error ? error.name : "ERROR" });
    }
  }

  // 5. retention
  if (options.purge) summary.purged = await fanoutRepo.purge(deps.now(), RETENTION, 500);
  return summary;
}

// Read access to an integration's inbound events, deliveries and log, plus admin replay.
// Lists never contain payloads; a single inbound event shows its stored payload only to integrations.manage.
import { InvalidStateError, NotFoundError, parseInput } from "@/lib/errors";
import { hasPermission, requirePermission, type TenantContext } from "@/modules/tenancy";
import { deliveryAdminRepo, type DeliveryListRow } from "../repo/deliveryRepo";
import { inboundAdminRepo, type InboundListRow } from "../repo/inboundRepo";
import { appendLog, logRepo } from "../repo/logRepo";
import { listDeliveriesSchema, listInboundEventsSchema, listLogsSchema } from "../schemas";
import type { DeliveryDto, InboundEventDto, IntegrationLogDto } from "../types";
import { requireIntegration } from "./integrations";

function toInboundDto(e: InboundListRow & { payload?: unknown }): InboundEventDto {
  return {
    id: e.id,
    externalEventId: e.externalEventId,
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    status: e.status,
    attempts: e.attempts,
    nextAttemptAt: e.nextAttemptAt.toISOString(),
    resultType: e.resultType,
    resultId: e.resultId,
    lastErrorCode: e.lastErrorCode,
    lastErrorSummary: e.lastErrorSummary,
    correlationId: e.correlationId,
    receivedAt: e.receivedAt.toISOString(),
    processedAt: e.processedAt?.toISOString() ?? null,
    ...("payload" in e ? { payload: e.payload } : {}),
  };
}

function toDeliveryDto(d: DeliveryListRow): DeliveryDto {
  return {
    id: d.id,
    eventId: d.outboxEventId,
    eventType: d.outboxEvent.eventType,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt.toISOString(),
    lastHttpStatus: d.lastHttpStatus,
    lastErrorCode: d.lastErrorCode,
    lastErrorSummary: d.lastErrorSummary,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function listInboundEvents(ctx: TenantContext, integrationId: string, raw: unknown = {}): Promise<InboundEventDto[]> {
  requirePermission(ctx, "integrations.view");
  await requireIntegration(ctx, integrationId);
  const { status, limit } = parseInput(listInboundEventsSchema, raw);
  return (await inboundAdminRepo(ctx).list(integrationId, { status }, limit)).map(toInboundDto);
}

export async function getInboundEvent(ctx: TenantContext, integrationId: string, eventId: string): Promise<InboundEventDto> {
  requirePermission(ctx, "integrations.view");
  await requireIntegration(ctx, integrationId);
  const event = await inboundAdminRepo(ctx).get(integrationId, eventId, hasPermission(ctx, "integrations.manage"));
  if (!event) throw new NotFoundError("Event not found");
  return toInboundDto(event as InboundListRow & { payload?: unknown });
}

export async function replayInboundEvent(ctx: TenantContext, integrationId: string, eventId: string): Promise<InboundEventDto> {
  requirePermission(ctx, "integrations.manage");
  const integration = await requireIntegration(ctx, integrationId);
  const repo = inboundAdminRepo(ctx);
  const event = await repo.findForLog(integrationId, eventId);
  if (!event) throw new NotFoundError("Event not found");
  if ((await repo.replay(integrationId, eventId, new Date())) === 0) {
    throw new InvalidStateError("Only rejected, failed or dead events can be replayed");
  }
  await appendLog({
    organizationId: ctx.organizationId,
    integrationId,
    direction: "INBOUND",
    provider: integration.provider,
    eventId: event.externalEventId,
    eventType: event.eventType,
    inboundEventId: event.id,
    correlationId: event.correlationId,
    status: "REPLAYED",
    safeSummary: "Event queued for processing again by an administrator",
  });
  return getInboundEvent(ctx, integrationId, eventId);
}

export async function listDeliveries(ctx: TenantContext, integrationId: string, raw: unknown = {}): Promise<DeliveryDto[]> {
  requirePermission(ctx, "integrations.view");
  await requireIntegration(ctx, integrationId);
  const { status, limit } = parseInput(listDeliveriesSchema, raw);
  return (await deliveryAdminRepo(ctx).list(integrationId, { status }, limit)).map(toDeliveryDto);
}

export async function replayDelivery(ctx: TenantContext, integrationId: string, deliveryId: string): Promise<DeliveryDto[]> {
  requirePermission(ctx, "integrations.manage");
  const integration = await requireIntegration(ctx, integrationId);
  const repo = deliveryAdminRepo(ctx);
  const delivery = await repo.findForLog(integrationId, deliveryId);
  if (!delivery) throw new NotFoundError("Delivery not found");
  if ((await repo.replay(integrationId, deliveryId, new Date())) === 0) {
    throw new InvalidStateError("Only failed or dead deliveries can be replayed");
  }
  await appendLog({
    organizationId: ctx.organizationId,
    integrationId,
    direction: "OUTBOUND",
    provider: integration.provider,
    eventId: delivery.outboxEventId,
    eventType: delivery.outboxEvent.eventType,
    deliveryId: delivery.id,
    correlationId: crypto.randomUUID(),
    status: "REPLAYED",
    safeSummary: "Delivery queued again by an administrator",
  });
  return listDeliveries(ctx, integrationId, {});
}

export async function listIntegrationLogs(ctx: TenantContext, integrationId: string, raw: unknown = {}): Promise<IntegrationLogDto[]> {
  requirePermission(ctx, "integrations.view");
  await requireIntegration(ctx, integrationId);
  const { limit } = parseInput(listLogsSchema, raw);
  return (await logRepo(ctx).list(integrationId, limit)).map((l) => ({
    id: l.id,
    direction: l.direction,
    provider: l.provider,
    eventId: l.eventId,
    eventType: l.eventType,
    correlationId: l.correlationId,
    status: l.status,
    attempt: l.attempt,
    httpStatus: l.httpStatus,
    durationMs: l.durationMs,
    safeSummary: l.safeSummary,
    createdAt: l.createdAt.toISOString(),
  }));
}

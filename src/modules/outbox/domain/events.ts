// Domain events recorded by core services. Pure types and constants: no I/O.
//
// Events are THIN: ids, business identifiers, quantities and (for packing) package data. They never
// contain credentials, raw external payloads or personal data beyond what the WMS itself stores.
// Consumers dedupe by the event id; the payload carries `schemaVersion`-1 shapes only.

export const OUTBOX_EVENT_TYPES = ["order.created", "order.allocated", "order.picked", "order.packed", "order.cancelled"] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export const OUTBOX_SCHEMA_VERSION = 1;
/** Application-level cap (the database CHECK allows 256 KiB). */
export const MAX_OUTBOX_PAYLOAD_BYTES = 64 * 1024;

export function isOutboxEventType(value: string): value is OutboxEventType {
  return (OUTBOX_EVENT_TYPES as readonly string[]).includes(value);
}

export interface OutboxEventInput {
  type: OutboxEventType;
  payload: Record<string, unknown>;
}

/** Identity of the order an event is about. */
export interface OrderEventRef {
  id: string;
  orderNumber: string;
  externalRef: string | null;
}

export interface OrderEventLine {
  sku: string;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  packedQty: number;
}

/** Common payload head: stable identifiers a consumer can correlate on. */
export function orderPayload(order: OrderEventRef, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { orderId: order.id, orderNumber: order.orderNumber, externalRef: order.externalRef, ...extra };
}

export function lineSummaries(lines: ReadonlyArray<{ product: { sku: string }; requestedQty: number; allocatedQty: number; pickedQty: number; packedQty: number }>): OrderEventLine[] {
  return lines.map((l) => ({ sku: l.product.sku, requestedQty: l.requestedQty, allocatedQty: l.allocatedQty, pickedQty: l.pickedQty, packedQty: l.packedQty }));
}

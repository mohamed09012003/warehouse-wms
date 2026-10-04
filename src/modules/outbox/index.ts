// Public API of the outbox module: the ONLY thing core services use to publish domain events.
// It knows nothing about integrations, providers or delivery; the integrations worker consumes it.
export { recordEvent } from "./service/recordEvent";
export {
  OUTBOX_EVENT_TYPES,
  OUTBOX_SCHEMA_VERSION,
  isOutboxEventType,
  orderPayload,
  lineSummaries,
} from "./domain/events";
export type { OutboxEventType, OutboxEventInput, OrderEventRef, OrderEventLine } from "./domain/events";

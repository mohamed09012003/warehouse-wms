// Ports of the integration layer. Adapters implement these; core services never import this folder.
// Adapters return CLASSIFIED, SAFE outcomes instead of throwing raw provider errors: no response
// bodies, headers or credentials ever travel through these types.
import type { ZodType } from "zod";
import type { TenantContext } from "@/modules/tenancy";
import type { Tx } from "@/server/db";

/** A secret as held in memory for one operation: the current value and, within the rotation grace period, the previous one. */
export interface SecretValue {
  current?: string;
  previous?: string;
}
export type SecretValues = Readonly<Record<string, SecretValue>>;

/** The non-secret view of an integration that adapters receive. */
export interface AdapterIntegration {
  id: string;
  organizationId: string;
  provider: string;
  config: unknown;
}

// ---- HTTP port (the only way adapters touch the network) --------------------------------------

export interface HttpRequest {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  /** Lower-cased response headers (first value). Bodies are drained and discarded, never exposed. */
  headers: Record<string, string>;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}
export type HttpErrorCode = "TARGET_NOT_ALLOWED" | "INVALID_URL" | "DNS_FAILED" | "CONNECTION_FAILED" | "TIMEOUT" | "RESPONSE_TOO_LARGE" | "TLS_FAILED";
export class HttpClientError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HttpClientError";
  }
}

// ---- Inbound ---------------------------------------------------------------------------------------

export interface InboundEnvelope {
  eventId: string;
  type: string;
  occurredAt: Date;
  data: unknown;
}
export type VerifyResult =
  | { status: "ok"; envelope: InboundEnvelope }
  /** Signature/timestamp problem. The caller answers every such case identically. */
  | { status: "unauthenticated" }
  /** Authenticated but not a valid envelope. */
  | { status: "malformed"; message: string };

export interface InboundHandlerContext {
  ctx: TenantContext;
  tx: Tx;
  integration: AdapterIntegration;
  inboundEventId: string;
}
export interface HandlerResult {
  resultType: string;
  resultId: string;
}
export interface InboundHandler<T = unknown> {
  schema: ZodType<T>;
  handle(hctx: InboundHandlerContext, data: T): Promise<HandlerResult>;
}

export interface InboundAdapter {
  provider: string;
  configSchema: ZodType;
  /** Names of the secrets this provider understands. */
  secretNames: readonly string[];
  /** Pure: authenticate the raw request and parse the provider's envelope. */
  verify(input: { rawBody: string; header: (name: string) => string | null; secrets: SecretValues; now: Date }): VerifyResult;
  handlers: Readonly<Record<string, InboundHandler>>;
}

// ---- Outbound --------------------------------------------------------------------------------------

export interface OutboundEvent {
  /** Stable event id (the outbox event id): identical on every attempt. */
  id: string;
  type: string;
  schemaVersion: number;
  occurredAt: string;
  seq: string;
  payload: unknown;
}
export interface DeliveryContext {
  integration: AdapterIntegration;
  secrets: SecretValues;
  http: HttpClient;
  now: Date;
  attempt: number;
  /** Per-attempt delivery id. */
  deliveryId: string;
}
export type DeliveryOutcome =
  | { kind: "ok"; httpStatus?: number; durationMs?: number }
  | { kind: "retry"; code: string; summary: string; httpStatus?: number; retryAfterMs?: number; durationMs?: number }
  | { kind: "fail"; code: string; summary: string; httpStatus?: number; durationMs?: number };

export interface OutboundAdapter {
  provider: string;
  configSchema: ZodType;
  secretNames: readonly string[];
  /** Whether this integration wants the event type (evaluated at fan-out time). */
  subscribes(config: unknown, eventType: string): boolean;
  deliver(dctx: DeliveryContext, event: OutboundEvent): Promise<DeliveryOutcome>;
}

export interface ProviderDefinition {
  provider: string;
  label: string;
  /**
   * Problems that stop an integration from being enabled (missing secret, missing target ...). Empty = ready.
   * `secretsSet` holds the names of the secrets that have a current value.
   */
  readiness(integration: { inboundEnabled: boolean; outboundEnabled: boolean; config: unknown }, secretsSet: ReadonlySet<string>): string[];
  /** Grants a freshly created integration of this provider receives by default (subset of the allowlist). */
  defaultGrants: readonly string[];
  inbound?: InboundAdapter;
  outbound?: OutboundAdapter;
}

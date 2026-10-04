// Plain shapes returned by the integrations services and API. Type-only: safe for client components.
// Nothing here can carry a secret value: secrets appear only as metadata (name, isSet, rotatedAt).

export interface SecretMetaDto {
  name: string;
  isSet: boolean;
  rotatedAt: string | null;
  /** A previous value is still accepted during the rotation grace period. */
  hasPrevious: boolean;
}

export interface DirectionHealthDto {
  healthStatus: "HEALTHY" | "DEGRADED" | "FAILING";
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastErrorSummary: string | null;
}

export interface IntegrationDto {
  id: string;
  name: string;
  provider: string;
  providerLabel: string;
  /** Path (relative to the site) the external system posts to. The signature, not the path, authenticates. */
  webhookPath: string;
  inboundEnabled: boolean;
  outboundEnabled: boolean;
  enabled: boolean;
  disabledReason: string | null;
  config: Record<string, unknown>;
  grants: string[];
  /** Health is tracked independently per direction. */
  inbound: DirectionHealthDto;
  outbound: DirectionHealthDto;
  /** Set when the circuit breaker paused outbound delivery. */
  outboundPausedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  secrets: SecretMetaDto[];
  /** What still stops the integration from being enabled (empty when ready). */
  readinessProblems: string[];
}

export interface InboundEventDto {
  id: string;
  externalEventId: string;
  eventType: string;
  occurredAt: string;
  status: "RECEIVED" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "REJECTED" | "DEAD";
  attempts: number;
  nextAttemptAt: string;
  resultType: string | null;
  resultId: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  correlationId: string;
  receivedAt: string;
  processedAt: string | null;
  /** Only in the detail view and only with integrations.manage. */
  payload?: unknown;
}

export interface DeliveryDto {
  id: string;
  eventId: string;
  eventType: string;
  status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "DEAD";
  attempts: number;
  nextAttemptAt: string;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface IntegrationLogDto {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  provider: string;
  eventId: string | null;
  eventType: string | null;
  correlationId: string;
  status: string;
  attempt: number;
  httpStatus: number | null;
  durationMs: number | null;
  safeSummary: string;
  createdAt: string;
}

export interface TestResultDto {
  ok: boolean;
  httpStatus: number | null;
  code: string | null;
  summary: string;
  durationMs: number | null;
}

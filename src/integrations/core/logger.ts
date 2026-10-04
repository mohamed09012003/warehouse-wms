// Structured, allowlisted console logging for the integration layer. Only the fields below are ever
// emitted, strings are redacted and truncated, and payloads/headers/secrets have no way in.
import { redactText } from "@/lib/redact";

const ALLOWED = new Set([
  "integrationId",
  "organizationId",
  "provider",
  "eventId",
  "eventType",
  "deliveryId",
  "inboundEventId",
  "correlationId",
  "status",
  "attempt",
  "httpStatus",
  "durationMs",
  "code",
  "count",
  // admin actions: who did what to which integration (never a value)
  "actorUserId",
  "secretName",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Level = "info" | "warn" | "error";

export function logSafe(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED.has(key) || value === undefined || value === null) continue;
    // Identifiers (UUIDs) are the point of the log line; any other text is redacted.
    safe[key] = typeof value === "string" ? (UUID.test(value) ? value : redactText(value, 120)) : typeof value === "number" || typeof value === "boolean" ? value : undefined;
  }
  const line = JSON.stringify({ level, event: `integrations.${event}`, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

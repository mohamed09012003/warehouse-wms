// Outbound side of the generic webhook: POST the event as signed JSON.
//
//   headers: X-WMS-Event-Id (stable across retries), X-WMS-Delivery-Id (per attempt), X-WMS-Attempt,
//            X-WMS-Event-Type, X-WMS-Signature (t=<unix>,v1=<hmac>) over "<t>.<raw body>"
//
// Only those headers and the event body are ever sent: no stored secret, no credentials of any kind other
// than the HMAC signature itself. The remote response is reduced to a status code (and Retry-After).
import { performance } from "node:perf_hooks";
import { parseRetryAfter } from "../../core/retry";
import { HttpClientError, type DeliveryOutcome, type OutboundAdapter } from "../../core/types";
import { GENERIC_WEBHOOK_PROVIDER, INBOUND_SECRET, OUTBOUND_SECRET, genericWebhookConfigSchema } from "./config";
import { SIGNATURE_HEADER, signatureHeaderValue } from "./signature";

export const genericWebhookOutbound: OutboundAdapter = {
  provider: GENERIC_WEBHOOK_PROVIDER,
  configSchema: genericWebhookConfigSchema,
  secretNames: [INBOUND_SECRET, OUTBOUND_SECRET],

  subscribes(config, eventType) {
    const parsed = genericWebhookConfigSchema.safeParse(config);
    return parsed.success && (parsed.data.subscribedEvents as readonly string[]).includes(eventType);
  },

  async deliver(dctx, event): Promise<DeliveryOutcome> {
    const config = genericWebhookConfigSchema.safeParse(dctx.integration.config);
    if (!config.success) return { kind: "fail", code: "CONFIG_INVALID", summary: "The integration configuration is invalid" };
    if (!config.data.targetUrl) return { kind: "fail", code: "NO_TARGET_URL", summary: "No target URL is configured" };
    const secret = dctx.secrets[OUTBOUND_SECRET]?.current;
    if (!secret) return { kind: "fail", code: "MISSING_SECRET", summary: "The outbound signing secret is not set" };

    const body = JSON.stringify({
      eventId: event.id,
      type: event.type,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      sequence: event.seq,
      data: event.payload,
    });
    const timestamp = Math.floor(dctx.now.getTime() / 1000);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "wms-integrations/1",
      "X-WMS-Event-Id": event.id,
      "X-WMS-Event-Type": event.type,
      "X-WMS-Delivery-Id": dctx.deliveryId,
      "X-WMS-Attempt": String(dctx.attempt),
      [SIGNATURE_HEADER]: signatureHeaderValue(secret, timestamp, body),
    };

    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const res = await dctx.http.request({ method: "POST", url: config.data.targetUrl, headers, body });
      const durationMs = elapsed();
      const s = res.status;
      if (s >= 200 && s < 300) return { kind: "ok", httpStatus: s, durationMs };
      if (s === 408 || s === 429) {
        return { kind: "retry", code: `HTTP_${s}`, summary: `Target responded with HTTP ${s}`, httpStatus: s, retryAfterMs: parseRetryAfter(res.headers["retry-after"], dctx.now), durationMs };
      }
      if (s >= 500) {
        return { kind: "retry", code: `HTTP_${s}`, summary: `Target responded with HTTP ${s}`, httpStatus: s, retryAfterMs: parseRetryAfter(res.headers["retry-after"], dctx.now), durationMs };
      }
      if (s >= 300 && s < 400) {
        return { kind: "fail", code: "REDIRECT_NOT_FOLLOWED", summary: `Target answered with a redirect (HTTP ${s}); redirects are not followed`, httpStatus: s, durationMs };
      }
      if (s >= 400) return { kind: "fail", code: `HTTP_${s}`, summary: `Target rejected the event with HTTP ${s}`, httpStatus: s, durationMs };
      return { kind: "retry", code: "UNEXPECTED_STATUS", summary: `Unexpected HTTP status ${s}`, httpStatus: s, durationMs };
    } catch (error) {
      const durationMs = elapsed();
      if (error instanceof HttpClientError) {
        // Policy problems cannot succeed by waiting; network trouble can.
        if (error.code === "TARGET_NOT_ALLOWED" || error.code === "INVALID_URL") return { kind: "fail", code: error.code, summary: error.message, durationMs };
        return { kind: "retry", code: error.code, summary: error.message, durationMs };
      }
      return { kind: "retry", code: "DELIVERY_ERROR", summary: "Delivery failed unexpectedly", durationMs };
    }
  },
};

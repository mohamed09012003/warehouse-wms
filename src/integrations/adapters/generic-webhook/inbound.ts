import { summarizeZodError } from "../../core/errors";
import type { InboundAdapter, VerifyResult } from "../../core/types";
import { GENERIC_WEBHOOK_PROVIDER, INBOUND_SECRET, OUTBOUND_SECRET, genericWebhookConfigSchema } from "./config";
import { genericWebhookHandlers } from "./inboundHandlers";
import { envelopeSchema } from "./inboundSchemas";
import { SIGNATURE_HEADER, verifySignature } from "./signature";

export const genericWebhookInbound: InboundAdapter = {
  provider: GENERIC_WEBHOOK_PROVIDER,
  configSchema: genericWebhookConfigSchema,
  secretNames: [INBOUND_SECRET, OUTBOUND_SECRET],

  verify({ rawBody, header, secrets, now }): VerifyResult {
    const secret = secrets[INBOUND_SECRET];
    const candidates = [secret?.current, secret?.previous].filter((v): v is string => !!v);
    // Any signature/timestamp/secret problem is the same answer to the caller.
    if (verifySignature({ header: header(SIGNATURE_HEADER), rawBody, secrets: candidates, now }) !== "ok") return { status: "unauthenticated" };

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { status: "malformed", message: "Request body is not valid JSON" };
    }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) return { status: "malformed", message: summarizeZodError(parsed.error) };
    const { eventId, type, occurredAt, data } = parsed.data;
    return { status: "ok", envelope: { eventId, type, occurredAt: new Date(occurredAt), data } };
  },

  handlers: genericWebhookHandlers,
};

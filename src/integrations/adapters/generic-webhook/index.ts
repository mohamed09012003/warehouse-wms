import type { ProviderDefinition } from "../../core/types";
import { GENERIC_WEBHOOK_PROVIDER, INBOUND_SECRET, OUTBOUND_SECRET, genericWebhookConfigSchema } from "./config";
import { genericWebhookInbound } from "./inbound";
import { genericWebhookOutbound } from "./outbound";

export const genericWebhookProvider: ProviderDefinition = {
  provider: GENERIC_WEBHOOK_PROVIDER,
  label: "Generic signed webhook",
  defaultGrants: ["products.manage", "orders.manage"],
  readiness(integration, secretsSet) {
    const problems: string[] = [];
    if (!integration.inboundEnabled && !integration.outboundEnabled) problems.push("Turn on inbound and/or outbound first");
    if (integration.inboundEnabled && !secretsSet.has(INBOUND_SECRET)) problems.push("Set the inbound signing secret");
    if (integration.outboundEnabled) {
      const config = genericWebhookConfigSchema.safeParse(integration.config);
      if (!config.success || !config.data.targetUrl) problems.push("Set a valid target URL");
      if (!secretsSet.has(OUTBOUND_SECRET)) problems.push("Set the outbound signing secret");
    }
    return problems;
  },
  inbound: genericWebhookInbound,
  outbound: genericWebhookOutbound,
};

export { GENERIC_WEBHOOK_PROVIDER, INBOUND_SECRET, OUTBOUND_SECRET };
export { SIGNATURE_HEADER, signatureHeaderValue, verifySignature } from "./signature";

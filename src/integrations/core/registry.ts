// Code-defined provider registry. Adding a provider (ERP, shop, carrier) means adding a definition here;
// nothing in the core domain changes.
import { genericWebhookProvider } from "../adapters/generic-webhook";
import type { ProviderDefinition } from "./types";

const PROVIDERS: readonly ProviderDefinition[] = [genericWebhookProvider];

export function listProviders(): readonly ProviderDefinition[] {
  return PROVIDERS;
}

export function getProvider(provider: string): ProviderDefinition | undefined {
  return PROVIDERS.find((p) => p.provider === provider);
}

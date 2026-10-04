import { getIntegration, updateIntegration } from "@/integrations";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ id: string }>(({ ctx, params }) => getIntegration(ctx, params.id));

// Body: any of { name, inboundEnabled, outboundEnabled, config, grants (Owner only), archived }.
export const PATCH = tenantRoute<{ id: string }>(async ({ ctx, request, params }) => updateIntegration(ctx, params.id, await readJson(request)));

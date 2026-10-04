import { createIntegration, listIntegrations } from "@/integrations";
import { queryOf, readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => listIntegrations(ctx, queryOf(request).includeArchived === "true"));

export const POST = tenantRoute(async ({ ctx, request }) => createIntegration(ctx, await readJson(request)));

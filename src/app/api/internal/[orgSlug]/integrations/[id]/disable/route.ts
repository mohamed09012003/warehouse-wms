import { disableIntegration } from "@/integrations";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

// Optional body: { reason }.
export const POST = tenantRoute<{ id: string }>(async ({ ctx, request, params }) => {
  const raw = request.headers.get("content-type")?.includes("application/json") ? await readJson(request) : {};
  return disableIntegration(ctx, params.id, raw);
});

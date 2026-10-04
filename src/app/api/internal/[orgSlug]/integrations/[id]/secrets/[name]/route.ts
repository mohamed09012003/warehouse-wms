import { deleteIntegrationSecret, setIntegrationSecret } from "@/integrations";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

// Write-only: the response is metadata ({ name, isSet, rotatedAt, hasPrevious }), never the value.
// Body: { value }.
export const PUT = tenantRoute<{ id: string; name: string }>(async ({ ctx, request, params }) =>
  setIntegrationSecret(ctx, params.id, params.name, await readJson(request)),
);

export const DELETE = tenantRoute<{ id: string; name: string }>(({ ctx, params }) => deleteIntegrationSecret(ctx, params.id, params.name));

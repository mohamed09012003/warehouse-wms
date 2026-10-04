import { listIntegrationLogs } from "@/integrations";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

// Query: ?limit=50. Safe summaries only.
export const GET = tenantRoute<{ id: string }>(({ ctx, request, params }) => listIntegrationLogs(ctx, params.id, queryOf(request)));

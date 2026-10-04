import { listDeliveries } from "@/integrations";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

// Query: ?status=DEAD&limit=50.
export const GET = tenantRoute<{ id: string }>(({ ctx, request, params }) => listDeliveries(ctx, params.id, queryOf(request)));

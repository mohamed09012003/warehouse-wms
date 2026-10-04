import { listInboundEvents } from "@/integrations";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

// Query: ?status=REJECTED&limit=50. Never includes payloads.
export const GET = tenantRoute<{ id: string }>(({ ctx, request, params }) => listInboundEvents(ctx, params.id, queryOf(request)));

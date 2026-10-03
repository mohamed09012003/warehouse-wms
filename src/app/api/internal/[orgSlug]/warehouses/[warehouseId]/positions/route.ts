import { searchPositions } from "@/modules/warehouse";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

// Type-ahead for location codes: GET .../positions?q=R01-L01
export const GET = tenantRoute<{ warehouseId: string }>(({ ctx, request, params }) =>
  searchPositions(ctx, params.warehouseId, queryOf(request).q ?? ""),
);

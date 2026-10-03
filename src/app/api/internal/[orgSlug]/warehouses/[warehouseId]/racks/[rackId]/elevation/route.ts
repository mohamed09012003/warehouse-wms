import { getRackElevation } from "@/modules/warehouse";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ warehouseId: string; rackId: string }>(({ ctx, params }) =>
  getRackElevation(ctx, params.warehouseId, params.rackId),
);

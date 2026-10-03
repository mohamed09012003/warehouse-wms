import { listStock } from "@/modules/inventory";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const q = queryOf(request);
  return listStock(ctx, {
    productId: q.productId || undefined,
    warehouseId: q.warehouseId || undefined,
    positionId: q.positionId || undefined,
    search: q.search || undefined,
  });
});

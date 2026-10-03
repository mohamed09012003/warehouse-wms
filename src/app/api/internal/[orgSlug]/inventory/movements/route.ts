import { listMovements } from "@/modules/inventory";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const q = queryOf(request);
  return listMovements(ctx, {
    productId: q.productId || undefined,
    positionId: q.positionId || undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  });
});

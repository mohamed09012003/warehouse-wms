import { createOrder, listOrders } from "@/modules/orders";
import { queryOf, readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const q = queryOf(request);
  return listOrders(ctx, { status: q.status || undefined, search: q.search || undefined });
});

export const POST = tenantRoute(async ({ ctx, request }) => createOrder(ctx, await readJson(request)));

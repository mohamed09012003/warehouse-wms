import { createProduct, listProducts } from "@/modules/catalog";
import { queryOf, readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const q = queryOf(request);
  return listProducts(ctx, { search: q.search || undefined, includeInactive: q.includeInactive === "true" });
});

export const POST = tenantRoute(async ({ ctx, request }) => createProduct(ctx, await readJson(request)));

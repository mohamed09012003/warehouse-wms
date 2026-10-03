import { addBarcode } from "@/modules/catalog";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ productId: string }>(async ({ ctx, request, params }) =>
  addBarcode(ctx, params.productId, await readJson(request)),
);

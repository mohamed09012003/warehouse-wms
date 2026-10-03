import { getProduct, updateProduct } from "@/modules/catalog";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

type P = { productId: string };

export const GET = tenantRoute<P>(({ ctx, params }) => getProduct(ctx, params.productId));

export const PATCH = tenantRoute<P>(async ({ ctx, request, params }) => updateProduct(ctx, params.productId, await readJson(request)));

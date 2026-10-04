import { markOrderReady } from "@/modules/orders";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ orderId: string }>(async ({ ctx, request, params }) => {
  await readJson(request); // JSON content type required (blocks cross-site form posts)
  return markOrderReady(ctx, params.orderId);
});

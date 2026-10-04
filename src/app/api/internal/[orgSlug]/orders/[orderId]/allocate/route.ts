import { allocateOrder } from "@/modules/picking";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ orderId: string }>(async ({ ctx, request, params }) => {
  await readJson(request); // JSON content type required (blocks cross-site form posts)
  return allocateOrder(ctx, { orderId: params.orderId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined });
});

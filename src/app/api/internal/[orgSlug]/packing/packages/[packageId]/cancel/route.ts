import { cancelPackage } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ packageId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>; // JSON content type required
  return cancelPackage(ctx, { packageId: params.packageId, idempotencyKey: body.idempotencyKey });
});

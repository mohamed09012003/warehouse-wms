import { updatePackage } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// Body: { packageType, weightG, lengthMm, widthMm, heightMm } for an OPEN package; null clears a value.
export const PATCH = tenantRoute<{ packageId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>;
  return updatePackage(ctx, { ...body, packageId: params.packageId });
});

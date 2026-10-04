import { createPackage } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// Body (all optional): { packageType, weightG, lengthMm, widthMm, heightMm }  (grams / millimetres, integers)
export const POST = tenantRoute<{ sessionId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>;
  return createPackage(ctx, { ...body, sessionId: params.sessionId });
});

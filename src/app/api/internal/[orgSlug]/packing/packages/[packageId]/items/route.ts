import { addPackageItem } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// The ONE add-to-package endpoint. Body: { productCode, quantity, orderLineId? }.
// A barcode scanner can send exactly the same request: the code it reads goes in productCode.
// Send an Idempotency-Key header so a retried or double-submitted request adds the quantity once.
export const POST = tenantRoute<{ packageId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>;
  return addPackageItem(ctx, { ...body, packageId: params.packageId });
});

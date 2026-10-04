import { removePackageItem, setPackageItemQuantity } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// PATCH body: { quantity } (>= 1). Only items of OPEN packages can change.
export const PATCH = tenantRoute<{ itemId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>;
  return setPackageItemQuantity(ctx, { ...body, itemId: params.itemId });
});

// DELETE removes the item from an OPEN package (its quantity becomes unpacked again). Send a JSON body ({}).
export const DELETE = tenantRoute<{ itemId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>;
  return removePackageItem(ctx, { itemId: params.itemId, idempotencyKey: body.idempotencyKey });
});

import { removeBarcode } from "@/modules/catalog";
import { tenantRoute } from "@/server/api/tenantRoute";

export const DELETE = tenantRoute<{ productId: string; barcodeId: string }>(({ ctx, params }) =>
  removeBarcode(ctx, params.productId, params.barcodeId),
);

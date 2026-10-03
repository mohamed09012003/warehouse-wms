import { getLayout, saveLayout } from "@/modules/warehouse";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

type P = { warehouseId: string };

export const GET = tenantRoute<P>(({ ctx, params }) => getLayout(ctx, params.warehouseId));

export const PUT = tenantRoute<P>(async ({ ctx, request, params }) =>
  saveLayout(ctx, params.warehouseId, await readJson(request)),
);

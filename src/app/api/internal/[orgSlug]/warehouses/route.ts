import { createWarehouse, listWarehouses } from "@/modules/warehouse";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx }) => listWarehouses(ctx));

export const POST = tenantRoute(async ({ ctx, request }) => createWarehouse(ctx, await readJson(request)));

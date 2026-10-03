import { createPalletType, listPalletTypes } from "@/modules/warehouse";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx }) => listPalletTypes(ctx));

export const POST = tenantRoute(async ({ ctx, request }) => createPalletType(ctx, await readJson(request)));

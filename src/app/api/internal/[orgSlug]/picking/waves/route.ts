import { createWave, listWaves } from "@/modules/picking";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx }) => listWaves(ctx));

export const POST = tenantRoute(async ({ ctx, request }) => createWave(ctx, await readJson(request)));

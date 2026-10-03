import { adjustStock } from "@/modules/inventory";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute(async ({ ctx, request }) => adjustStock(ctx, await readJsonWithIdempotency(request)));

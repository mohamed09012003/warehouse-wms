import { moveStock } from "@/modules/inventory";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute(async ({ ctx, request }) => moveStock(ctx, await readJsonWithIdempotency(request)));

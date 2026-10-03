import { receiveStock } from "@/modules/inventory";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute(async ({ ctx, request }) => receiveStock(ctx, await readJsonWithIdempotency(request)));

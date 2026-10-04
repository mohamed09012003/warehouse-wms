import { startPacking } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// Body: { orderId }. Send an Idempotency-Key header so a double submit starts packing once.
export const POST = tenantRoute(async ({ ctx, request }) => startPacking(ctx, await readJsonWithIdempotency(request)));

import { getPackingSession } from "@/modules/packing";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ sessionId: string }>(({ ctx, params }) => getPackingSession(ctx, params.sessionId));

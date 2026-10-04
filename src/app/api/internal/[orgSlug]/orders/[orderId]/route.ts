import { getOrder } from "@/modules/orders";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ orderId: string }>(({ ctx, params }) => getOrder(ctx, params.orderId));

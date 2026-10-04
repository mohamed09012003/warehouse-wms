import { listEligibleOrders } from "@/modules/picking";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx }) => listEligibleOrders(ctx));

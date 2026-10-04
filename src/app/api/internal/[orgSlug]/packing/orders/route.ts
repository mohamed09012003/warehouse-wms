import { listPackableOrders } from "@/modules/packing";
import { tenantRoute } from "@/server/api/tenantRoute";

// The packing queue: orders with picked quantity (partially picked orders included).
export const GET = tenantRoute(({ ctx }) => listPackableOrders(ctx));

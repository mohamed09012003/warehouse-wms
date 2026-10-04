import { replayDelivery } from "@/integrations";
import { tenantRoute } from "@/server/api/tenantRoute";

// Only FAILED or DEAD deliveries; returns the refreshed delivery list.
export const POST = tenantRoute<{ id: string; deliveryId: string }>(({ ctx, params }) => replayDelivery(ctx, params.id, params.deliveryId));

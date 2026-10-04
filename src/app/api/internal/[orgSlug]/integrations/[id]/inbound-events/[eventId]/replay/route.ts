import { replayInboundEvent } from "@/integrations";
import { tenantRoute } from "@/server/api/tenantRoute";

// Only REJECTED, FAILED or DEAD events; the event gets a fresh attempt budget.
export const POST = tenantRoute<{ id: string; eventId: string }>(({ ctx, params }) => replayInboundEvent(ctx, params.id, params.eventId));

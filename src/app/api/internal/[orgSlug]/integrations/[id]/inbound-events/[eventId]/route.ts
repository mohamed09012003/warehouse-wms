import { getInboundEvent } from "@/integrations";
import { tenantRoute } from "@/server/api/tenantRoute";

// Includes the stored payload for callers with integrations.manage.
export const GET = tenantRoute<{ id: string; eventId: string }>(({ ctx, params }) => getInboundEvent(ctx, params.id, params.eventId));

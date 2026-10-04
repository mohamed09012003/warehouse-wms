import { testIntegration } from "@/integrations";
import { tenantRoute } from "@/server/api/tenantRoute";

// Sends a signed `integration.test` event to the target synchronously (10 s timeout).
export const POST = tenantRoute<{ id: string }>(({ ctx, params }) => testIntegration(ctx, params.id));

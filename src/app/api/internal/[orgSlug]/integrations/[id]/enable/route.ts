import { enableIntegration } from "@/integrations";
import { tenantRoute } from "@/server/api/tenantRoute";

// Also resumes outbound delivery after the circuit breaker paused it.
export const POST = tenantRoute<{ id: string }>(({ ctx, params }) => enableIntegration(ctx, params.id));

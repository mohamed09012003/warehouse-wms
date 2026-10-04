import { getWave } from "@/modules/picking";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ waveId: string }>(({ ctx, params }) => getWave(ctx, params.waveId));

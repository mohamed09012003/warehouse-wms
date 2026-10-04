import { completeWave } from "@/modules/picking";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ waveId: string }>(async ({ ctx, request, params }) => {
  await readJson(request); // JSON content type required (blocks cross-site form posts)
  return completeWave(ctx, { waveId: params.waveId });
});

import { addOrdersToWave } from "@/modules/picking";
import { readJson, tenantRoute } from "@/server/api/tenantRoute";

// Body: { orderIds: string[] } - adds the unassigned pick tasks of those allocated orders to the wave.
export const POST = tenantRoute<{ waveId: string }>(async ({ ctx, request, params }) => {
  const body = (await readJson(request)) as { orderIds?: unknown };
  return addOrdersToWave(ctx, { waveId: params.waveId, orderIds: body?.orderIds });
});

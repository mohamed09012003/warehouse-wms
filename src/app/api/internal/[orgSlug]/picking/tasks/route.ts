import { listPickTasks } from "@/modules/picking";
import { queryOf, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const q = queryOf(request);
  return listPickTasks(ctx, { status: q.status || undefined, waveId: q.waveId || undefined });
});

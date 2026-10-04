import { getPickTask } from "@/modules/picking";
import { tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute<{ taskId: string }>(({ ctx, params }) => getPickTask(ctx, params.taskId));

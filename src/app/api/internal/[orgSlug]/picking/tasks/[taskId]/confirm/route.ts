import { confirmPick } from "@/modules/picking";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

// The ONE pick-confirmation endpoint. Body: { locationCode, productCode, quantity }.
// A barcode scanner can send exactly the same request: the codes it reads go in locationCode / productCode.
// Send an Idempotency-Key header so a retried or double-submitted request consumes stock once.
export const POST = tenantRoute<{ taskId: string }>(async ({ ctx, request, params }) => {
  const body = (await readJsonWithIdempotency(request)) as Record<string, unknown>;
  return confirmPick(ctx, { ...body, taskId: params.taskId });
});

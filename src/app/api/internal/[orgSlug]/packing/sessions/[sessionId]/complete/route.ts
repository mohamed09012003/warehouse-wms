import { completePacking } from "@/modules/packing";
import { readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ sessionId: string }>(async ({ ctx, request, params }) => {
  const body = ((await readJsonWithIdempotency(request)) ?? {}) as Record<string, unknown>; // JSON content type required
  return completePacking(ctx, { sessionId: params.sessionId, idempotencyKey: body.idempotencyKey });
});

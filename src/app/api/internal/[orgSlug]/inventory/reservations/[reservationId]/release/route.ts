import { releaseReservation } from "@/modules/inventory";
import { tenantRoute } from "@/server/api/tenantRoute";

export const POST = tenantRoute<{ reservationId: string }>(({ ctx, request, params }) =>
  releaseReservation(ctx, { reservationId: params.reservationId, idempotencyKey: request.headers.get("idempotency-key") ?? undefined }),
);

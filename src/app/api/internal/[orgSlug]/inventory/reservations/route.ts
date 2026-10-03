import { createReservation, listReservations } from "@/modules/inventory";
import { queryOf, readJsonWithIdempotency, tenantRoute } from "@/server/api/tenantRoute";

export const GET = tenantRoute(({ ctx, request }) => {
  const status = queryOf(request).status;
  return listReservations(ctx, status === "ACTIVE" || status === "RELEASED" ? status : undefined);
});

export const POST = tenantRoute(async ({ ctx, request }) => createReservation(ctx, await readJsonWithIdempotency(request)));

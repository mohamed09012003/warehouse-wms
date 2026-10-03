// Route-handler wrapper for tenant-scoped internal APIs (/api/internal/[orgSlug]/...).
// It resolves the tenant context from the SESSION (the slug is only a lookup key), runs the
// handler, and converts any thrown error into a consistent JSON error response.
// Route handlers stay thin: parse the request, call a module service, return JSON.
import "server-only";
import { ValidationError, toErrorResponse } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy";
import { requireTenantContext } from "@/server/auth/session";

type Params = Record<string, string>;
type RouteContext<P extends Params> = { params: Promise<{ orgSlug: string } & P> };

export function tenantRoute<P extends Params = Params>(
  handler: (args: { ctx: TenantContext; request: Request; params: P }) => Promise<unknown>,
) {
  return async (request: Request, route: RouteContext<P>): Promise<Response> => {
    try {
      const { orgSlug, ...params } = await route.params;
      const ctx = await requireTenantContext(orgSlug);
      const result = await handler({ ctx, request, params: params as unknown as P });
      return Response.json(result);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

/** Read a JSON body. Requiring the JSON content type also blocks plain cross-site form posts. */
export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ValidationError("Content-Type must be application/json");
  }
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

/** Query-string parameters as a plain object (first value wins). */
export function queryOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

/** Read a JSON body and merge the standard `Idempotency-Key` header into it (header wins). */
export async function readJsonWithIdempotency(request: Request): Promise<unknown> {
  const body = await readJson(request);
  const key = request.headers.get("idempotency-key");
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return key ? { ...(body as Record<string, unknown>), idempotencyKey: key } : body;
  }
  return body;
}

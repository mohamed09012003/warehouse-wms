// Browser-side fetch helper for the internal JSON API (/api/internal/[orgSlug]/...).
// Contains no business rules: it only sends requests and turns error responses into ApiError.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function apiRequest<T>(url: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  const res = await fetch(url, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Validation errors carry the first field problem in `details`; show it instead of a bare "Invalid input".
    const firstIssue = Array.isArray(body?.error?.details) ? body.error.details[0]?.message : undefined;
    const message = body?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(firstIssue && body?.error?.code === "VALIDATION_FAILED" ? `${message}: ${firstIssue}` : message, res.status, body?.error?.code ?? "ERROR");
  }
  return body as T;
}

export const orgApi = (orgSlug: string) => `/api/internal/${encodeURIComponent(orgSlug)}`;

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  return error instanceof ApiError ? error.message : fallback;
}

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
    throw new ApiError(body?.error?.message ?? `Request failed (${res.status})`, res.status, body?.error?.code ?? "ERROR");
  }
  return body as T;
}

export const orgApi = (orgSlug: string) => `/api/internal/${encodeURIComponent(orgSlug)}`;

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  return error instanceof ApiError ? error.message : fallback;
}

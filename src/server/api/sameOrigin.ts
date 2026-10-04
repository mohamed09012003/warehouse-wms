// Same-origin check for cookie-authenticated, state-changing internal API requests (see tenantRoute).
import { AuthorizationError } from "@/lib/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated, state-changing requests: a browser always labels where a
 * request came from. Requests that are not same-origin (Sec-Fetch-Site) or whose Origin is not this
 * host are refused. Non-browser clients (no such headers) are unaffected: they cannot ride a cookie.
 */
export function assertSameOrigin(request: Request): void {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;
  const blocked = () => new AuthorizationError("Cross-site request blocked");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") throw blocked();
  const origin = request.headers.get("origin");
  if (origin === null) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw blocked();
  }
  const allowed = new Set(
    [request.headers.get("host"), request.headers.get("x-forwarded-host"), new URL(request.url).host].filter((h): h is string => !!h),
  );
  if (!allowed.has(originHost)) throw blocked();
}

// CSRF defence for cookie-authenticated, state-changing internal API calls.
import { describe, expect, it, vi } from "vitest";
import { AuthenticationError } from "@/lib/errors";
import { assertSameOrigin } from "../sameOrigin";
import { tenantRoute } from "../tenantRoute";

// The real session module needs a Next.js request scope; here "no session" is all we need.
vi.mock("@/server/auth/session", () => ({
  requireTenantContext: async () => {
    throw new AuthenticationError();
  },
}));

const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/internal/acme/integrations", { method, headers: { host: "localhost:3000", ...headers } });
const blocked = (r: Request) => {
  try {
    assertSameOrigin(r);
    return false;
  } catch (error) {
    expect((error as { code?: string }).code).toBe("FORBIDDEN");
    return true;
  }
};

describe("assertSameOrigin", () => {
  it("never interferes with safe methods, whatever the headers say", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(blocked(req(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }))).toBe(false);
    }
  });

  it("allows requests that carry no browser provenance headers (scripts, curl, server-to-server)", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) expect(blocked(req(method))).toBe(false);
  });

  it("allows same-origin browser requests", () => {
    expect(blocked(req("POST", { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }))).toBe(false);
    expect(blocked(req("PATCH", { "sec-fetch-site": "none" }))).toBe(false); // user-initiated navigation
    expect(blocked(req("DELETE", { origin: "http://localhost:3000" }))).toBe(false);
  });

  it("blocks cross-site and same-site-but-different-origin requests on every state-changing method", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(blocked(req(method, { "sec-fetch-site": "cross-site" })), method).toBe(true);
      expect(blocked(req(method, { "sec-fetch-site": "same-site" })), method).toBe(true);
      expect(blocked(req(method, { origin: "https://evil.example" })), method).toBe(true);
    }
  });

  it("blocks a different port, scheme-less or opaque origins, and garbage", () => {
    expect(blocked(req("POST", { origin: "http://localhost:4000" }))).toBe(true);
    expect(blocked(req("POST", { origin: "null" }))).toBe(true);
    expect(blocked(req("POST", { origin: "not a url" }))).toBe(true);
    expect(blocked(req("POST", { origin: "http://localhost:3000.evil.example" }))).toBe(true);
  });

  it("accepts the forwarded host behind a reverse proxy", () => {
    const proxied = new Request("http://internal:3000/api/x", { method: "POST", headers: { host: "internal:3000", "x-forwarded-host": "wms.example.com", origin: "https://wms.example.com" } });
    expect(blocked(proxied)).toBe(false);
    const wrong = new Request("http://internal:3000/api/x", { method: "POST", headers: { host: "internal:3000", "x-forwarded-host": "wms.example.com", origin: "https://evil.example" } });
    expect(blocked(wrong)).toBe(true);
  });
});

describe("tenantRoute", () => {
  const handler = tenantRoute(async () => ({ reached: true }));
  const route = { params: Promise.resolve({ orgSlug: "acme" }) };

  it("refuses a cross-site state-changing request with 403 before doing anything else", async () => {
    const res = await handler(req("POST", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }), route);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatchObject({ code: "FORBIDDEN", message: "Cross-site request blocked" });
  });

  it("lets a same-origin request through to authentication (which then answers 401: no session in this test)", async () => {
    const res = await handler(req("POST", { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }), route);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("does not check provenance of GET requests", async () => {
    const res = await handler(req("GET", { "sec-fetch-site": "cross-site" }), route);
    expect(res.status).toBe(401); // reached authentication
  });
});

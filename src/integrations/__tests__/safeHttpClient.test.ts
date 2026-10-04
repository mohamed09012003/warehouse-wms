// SafeHttpClient: SSRF protection, redirects, size cap, timeout, address pinning. Uses real local servers
// as the "external system"; the strict client (no private-target override) must never reach them.
import { afterEach, describe, expect, it } from "vitest";
import { createSafeHttpClient } from "../http/safeHttpClient";
import { HttpClientError } from "../core/types";
import { startServer } from "../../../tests/support/integrations";

const body = JSON.stringify({ hello: "world" });
const req = (url: string, extra: Partial<{ headers: Record<string, string>; timeoutMs: number }> = {}) => ({ method: "POST" as const, url, headers: { "Content-Type": "application/json" }, body, ...extra });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no error";
  } catch (error) {
    if (error instanceof HttpClientError) return error.code;
    throw error;
  }
};

const servers: Awaited<ReturnType<typeof startServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const serve = async (handler: Parameters<typeof startServer>[0]) => {
  const s = await startServer(handler);
  servers.push(s);
  return s;
};

describe("SSRF protection (strict client)", () => {
  const strict = createSafeHttpClient({ production: false, allowPrivateTargets: false });

  it.each([
    ["loopback IPv4", "https://127.0.0.1/hook"],
    ["loopback IPv6", "https://[::1]/hook"],
    ["private 10/8", "https://10.0.0.5/hook"],
    ["private 172.16/12", "https://172.16.9.9/hook"],
    ["private 192.168/16", "https://192.168.1.10/hook"],
    ["link-local / cloud metadata", "https://169.254.169.254/latest/meta-data"],
    ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/hook"],
    ["unspecified address", "https://0.0.0.0/hook"],
    ["localhost by name", "https://localhost/hook"],
  ])("refuses %s", async (_label, url) => {
    expect(await code(strict.request(req(url)))).toBe("TARGET_NOT_ALLOWED");
  });

  it("never connects to a refused target", async () => {
    const server = await serve((_q, res) => res.end("ok"));
    // plain http to a loopback server: refused as an insecure scheme before any connection is attempted
    expect(await code(strict.request(req(server.url)))).toBe("INVALID_URL");
    expect(await code(strict.request(req(server.url.replace("http:", "https:"))))).toBe("TARGET_NOT_ALLOWED");
    expect(server.hits()).toBe(0);
  });

  it("refuses a host name that RESOLVES to a private address (DNS pointing inside)", async () => {
    const client = createSafeHttpClient({ production: false, resolve: async () => ["10.1.2.3"] });
    expect(await code(client.request(req("https://evil.example/hook")))).toBe("TARGET_NOT_ALLOWED");
    const mixed = createSafeHttpClient({ production: false, resolve: async () => ["8.8.8.8", "10.0.0.1"] });
    expect(await code(mixed.request(req("https://mixed.example/hook")))).toBe("TARGET_NOT_ALLOWED");
    const rebinding = createSafeHttpClient({ production: false, resolve: async () => ["169.254.169.254"] });
    expect(await code(rebinding.request(req("https://rebind.example/hook")))).toBe("TARGET_NOT_ALLOWED");
  });

  it("reports DNS failures separately", async () => {
    expect(await code(createSafeHttpClient({ resolve: async () => { throw new Error("nxdomain"); } }).request(req("https://nx.example/")))).toBe("DNS_FAILED");
    expect(await code(createSafeHttpClient({ resolve: async () => [] }).request(req("https://empty.example/")))).toBe("DNS_FAILED");
  });

  it("refuses bad URLs, other schemes and embedded credentials", async () => {
    for (const url of ["not a url", "ftp://example.com/x", "file:///etc/passwd", "https://user:pw@example.com/x", "javascript:alert(1)"]) {
      expect(await code(strict.request(req(url))), url).toBe("INVALID_URL");
    }
  });

  it("the private-target override is ignored in production", async () => {
    const server = await serve((_q, res) => res.end("ok"));
    const prod = createSafeHttpClient({ production: true, allowPrivateTargets: true });
    expect(await code(prod.request(req(server.url)))).toBe("INVALID_URL"); // http not allowed in production
    expect(await code(prod.request(req(server.url.replace("http:", "https:"))))).toBe("TARGET_NOT_ALLOWED");
    expect(server.hits()).toBe(0);
  });

  it("error messages never contain the URL, host name or credentials", async () => {
    const secretHost = "internal-secret-host.example";
    const client = createSafeHttpClient({ resolve: async () => ["10.0.0.9"] });
    try {
      await client.request(req(`https://${secretHost}/path?token=abc123`));
      expect.unreachable();
    } catch (error) {
      const text = String((error as Error).message) + JSON.stringify(error);
      expect(text).not.toContain(secretHost);
      expect(text).not.toContain("abc123");
    }
  });
});

describe("requests to an allowed (test) target", () => {
  const open = createSafeHttpClient({ production: false, allowPrivateTargets: true });

  it("delivers the body and returns only status and lower-cased headers", async () => {
    let received = "";
    let headers: Record<string, string | string[] | undefined> = {};
    const server = await serve((q, res) => {
      headers = q.headers;
      q.on("data", (c) => (received += c));
      q.on("end", () => {
        res.writeHead(202, { "X-Custom": "yes", "Retry-After": "7" });
        res.end("ignored body");
      });
    });
    const res = await open.request(req(server.url, { headers: { "Content-Type": "application/json", "X-Test": "1", "Content-Length": "1", Host: "evil.example" } }));
    expect(res.status).toBe(202);
    expect(res.headers["x-custom"]).toBe("yes");
    expect(res.headers["retry-after"]).toBe("7");
    expect(Object.keys(res)).toEqual(["status", "headers"]); // no body is ever exposed
    expect(received).toBe(body);
    expect(headers["x-test"]).toBe("1");
    expect(headers["content-length"]).toBe(String(Buffer.byteLength(body))); // computed, not caller-controlled
    expect(headers.host).toBe(new URL(server.url).host); // not caller-controlled
  });

  it("does NOT follow redirects (the redirect target is never contacted)", async () => {
    const target = await serve((_q, res) => res.end("internal"));
    const server = await serve((_q, res) => {
      res.writeHead(302, { Location: `${target.url}/secret` });
      res.end();
    });
    const res = await open.request(req(server.url));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(target.url);
    expect(server.hits()).toBe(1);
    expect(target.hits()).toBe(0);
  });

  it("aborts an oversized response", async () => {
    const server = await serve((_q, res) => {
      res.writeHead(200);
      res.write("x".repeat(40_000));
      res.end("y".repeat(40_000));
    });
    expect(await code(open.request(req(server.url)))).toBe("RESPONSE_TOO_LARGE");
    const small = await serve((_q, res) => res.end("x".repeat(1000)));
    expect((await open.request(req(small.url))).status).toBe(200);
    const custom = createSafeHttpClient({ production: false, allowPrivateTargets: true, maxResponseBytes: 10 });
    expect(await code(custom.request(req(small.url)))).toBe("RESPONSE_TOO_LARGE");
  });

  it("times out a server that never answers", async () => {
    const server = await serve(() => undefined);
    const started = Date.now();
    expect(await code(open.request(req(server.url, { timeoutMs: 150 })))).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(3000);
    const fast = createSafeHttpClient({ production: false, allowPrivateTargets: true, timeoutMs: 120 });
    expect(await code(fast.request(req(server.url)))).toBe("TIMEOUT");
  });

  it("reports a refused connection", async () => {
    const server = await serve((_q, res) => res.end());
    const url = server.url;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    expect(await code(open.request(req(url)))).toBe("CONNECTION_FAILED");
  });

  it("pins the connection to the validated address: the name is resolved once and the original host is kept for Host/SNI", async () => {
    let resolutions = 0;
    let hostHeader: string | undefined;
    const server = await serve((q, res) => {
      hostHeader = q.headers.host;
      res.end("ok");
    });
    const client = createSafeHttpClient({
      production: false,
      allowPrivateTargets: true,
      resolve: async () => {
        resolutions++;
        return ["127.0.0.1"];
      },
    });
    const url = new URL(server.url);
    const res = await client.request(req(`http://pinned.example:${url.port}/x`));
    expect(res.status).toBe(200);
    expect(resolutions).toBe(1);
    expect(hostHeader).toBe(`pinned.example:${url.port}`);
  });
});

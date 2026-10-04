// SafeHttpClient: the ONE way integration code makes outbound network calls.
//
//  - https only in production (http is allowed elsewhere only together with the private-target override)
//  - the hostname is resolved HERE, every resolved address must be public, and the connection is then
//    PINNED to the validated address (no second resolution, so DNS rebinding cannot swap it)
//  - redirects are never followed (a 3xx is just a status code the adapter classifies)
//  - overall timeout (default 10 s) and a response-size cap; response bodies are drained and discarded
//  - error messages are static: never the URL, headers, body or credentials
//  - private/loopback targets are reachable only with allowPrivateTargets (dev/test), never in production
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { getEnv } from "@/server/env";
import { HttpClientError, type HttpClient, type HttpRequest, type HttpResponse } from "../core/types";
import { isForbiddenAddress } from "./ipPolicy";

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

export interface SafeHttpClientOptions {
  /** Allow loopback/private targets and plain http (tests and local development only). Ignored when `production`. */
  allowPrivateTargets?: boolean;
  production?: boolean;
  /** Resolve a hostname to IP addresses. Defaults to the system resolver. Injectable for tests. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

async function systemResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address);
}

const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

export function createSafeHttpClient(options: SafeHttpClientOptions = {}): HttpClient {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const allowPrivate = !production && options.allowPrivateTargets === true;
  const resolve = options.resolve ?? systemResolve;
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    async request(req: HttpRequest): Promise<HttpResponse> {
      let url: URL;
      try {
        url = new URL(req.url);
      } catch {
        throw new HttpClientError("INVALID_URL", "The target URL is not valid");
      }
      const isHttps = url.protocol === "https:";
      if (!(isHttps || (url.protocol === "http:" && allowPrivate))) throw new HttpClientError("INVALID_URL", "Only https targets are allowed");
      if (url.username || url.password) throw new HttpClientError("INVALID_URL", "Credentials in the target URL are not allowed");

      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: string[];
      if (isIP(hostname)) addresses = [hostname];
      else {
        try {
          addresses = await resolve(hostname);
        } catch {
          throw new HttpClientError("DNS_FAILED", "The target host name could not be resolved");
        }
      }
      if (addresses.length === 0) throw new HttpClientError("DNS_FAILED", "The target host name could not be resolved");
      // EVERY address must be public: a name that also resolves to an internal address is refused outright.
      if (!allowPrivate && addresses.some((a) => isForbiddenAddress(a))) {
        throw new HttpClientError("TARGET_NOT_ALLOWED", "The target address is not allowed");
      }
      const pinned = addresses[0];

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (!RESERVED_HEADERS.has(k.toLowerCase())) headers[k] = v;
      headers.Host = url.host;
      headers["Content-Length"] = String(Buffer.byteLength(req.body));
      headers.Connection = "close";

      const timeoutMs = req.timeoutMs ?? defaultTimeout;
      const transport = isHttps ? https : http;

      return new Promise<HttpResponse>((resolvePromise, rejectPromise) => {
        let settled = false;
        const fail = (error: HttpClientError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.destroy();
          rejectPromise(error);
        };
        const request = transport.request(
          {
            method: req.method,
            // Connect to the validated address; keep the original host for SNI/certificate checks and the Host header.
            hostname: pinned,
            port: url.port ? Number(url.port) : isHttps ? 443 : 80,
            path: `${url.pathname}${url.search}`,
            headers,
            agent: false,
            ...(isHttps && !isIP(hostname) ? { servername: hostname } : {}),
          },
          (res) => {
            let received = 0;
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > maxBytes) fail(new HttpClientError("RESPONSE_TOO_LARGE", "The response was larger than the allowed size"));
            });
            res.on("end", () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              const out: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) out[k.toLowerCase()] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
              resolvePromise({ status: res.statusCode ?? 0, headers: out });
            });
            res.on("error", () => fail(new HttpClientError("CONNECTION_FAILED", "The connection failed while reading the response")));
          },
        );
        const timer = setTimeout(() => fail(new HttpClientError("TIMEOUT", "The request timed out")), timeoutMs);
        request.on("error", (error: NodeJS.ErrnoException) => {
          const code = error.code ?? "";
          if (/^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_OSSL)/.test(code)) fail(new HttpClientError("TLS_FAILED", "TLS negotiation with the target failed"));
          else if (code === "ENOTFOUND" || code === "EAI_AGAIN") fail(new HttpClientError("DNS_FAILED", "The target host name could not be resolved"));
          else fail(new HttpClientError("CONNECTION_FAILED", "Could not connect to the target"));
        });
        request.end(req.body);
      });
    },
  };
}

let shared: HttpClient | undefined;
/** The process-wide client used by the worker and admin test calls. */
export function getHttpClient(): HttpClient {
  shared ??= createSafeHttpClient({ allowPrivateTargets: getEnv().INTEGRATIONS_ALLOW_PRIVATE_TARGETS === "true" });
  return shared;
}

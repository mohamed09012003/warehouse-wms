// Fixtures for the integration-layer tests. Everything is obviously fake. Secrets are random "canary"
// strings so tests can prove they never leak anywhere.
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createIntegration, enableIntegration, setIntegrationSecret, updateIntegration } from "@/integrations";
import { INBOUND_SECRET, OUTBOUND_SECRET, signatureHeaderValue } from "@/integrations/adapters/generic-webhook";
import type { HttpClient, HttpRequest, HttpResponse } from "@/integrations/core/types";
import type { WorkerDeps } from "@/integrations/service/workerDeps";
import type { TenantContext } from "@/modules/tenancy";
import { prisma } from "./db";

let counter = 0;

/** A random, printable, >=16 character secret that is easy to grep for. */
export function canary(label: string): string {
  return `canary-${label}-${randomBytes(12).toString("hex")}`;
}

export interface TestIntegration {
  id: string;
  publicId: string;
  inboundSecret: string;
  outboundSecret: string;
}

/** Create, configure (secrets) and enable a generic-webhook integration through the real services. */
export async function newIntegration(
  ctx: TenantContext,
  opts: { name?: string; inbound?: boolean; outbound?: boolean; targetUrl?: string; events?: string[]; maxAttempts?: number; enable?: boolean } = {},
): Promise<TestIntegration> {
  counter += 1;
  const inbound = opts.inbound ?? true;
  const outbound = opts.outbound ?? false;
  const config: Record<string, unknown> = { subscribedEvents: opts.events ?? [] };
  if (opts.targetUrl) config.targetUrl = opts.targetUrl;
  if (opts.maxAttempts) config.maxAttempts = opts.maxAttempts;
  const dto = await createIntegration(ctx, {
    name: opts.name ?? `integration-${counter}`,
    provider: "generic-webhook",
    inboundEnabled: inbound,
    outboundEnabled: outbound,
    config,
  });
  const inboundSecret = canary("in");
  const outboundSecret = canary("out");
  if (inbound) await setIntegrationSecret(ctx, dto.id, INBOUND_SECRET, { value: inboundSecret });
  if (outbound) await setIntegrationSecret(ctx, dto.id, OUTBOUND_SECRET, { value: outboundSecret });
  if (opts.enable !== false) await enableIntegration(ctx, dto.id);
  return { id: dto.id, publicId: dto.webhookPath.split("/").pop()!, inboundSecret, outboundSecret };
}

export async function reconfigure(ctx: TenantContext, id: string, config: Record<string, unknown>) {
  return updateIntegration(ctx, id, { config });
}

export interface Envelope {
  eventId: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export function envelope(type: string, data: Record<string, unknown>, eventId: string = randomUUID()): Envelope {
  return { eventId, type, occurredAt: new Date().toISOString(), data };
}

/** A POST to the webhook endpoint, signed like an external system would sign it. */
export function signedRequest(
  publicId: string,
  secret: string,
  body: unknown,
  opts: { timestamp?: number; extraHeaders?: Record<string, string>; rawBody?: string; signature?: string } = {},
): Request {
  const raw = opts.rawBody ?? (typeof body === "string" ? body : JSON.stringify(body));
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  return new Request(`http://localhost/api/webhooks/${publicId}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wms-signature": opts.signature ?? signatureHeaderValue(secret, timestamp, raw),
      ...opts.extraHeaders,
    },
    body: raw,
  });
}

/** Scripted HTTP client: records requests and answers with whatever `handler` returns (or throws). */
export class FakeHttp implements HttpClient {
  requests: HttpRequest[] = [];
  constructor(public handler: (req: HttpRequest, index: number) => HttpResponse | Promise<HttpResponse> = () => ({ status: 200, headers: {} })) {}
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    return this.handler(req, this.requests.length - 1);
  }
}

export interface Clock {
  now: Date;
}
export function clockAt(iso = "2026-10-06T12:00:00.000Z"): Clock {
  return { now: new Date(iso) };
}
export function advance(clock: Clock, ms: number) {
  clock.now = new Date(clock.now.getTime() + ms);
}
export function depsFor(clock: Clock, http: HttpClient): WorkerDeps {
  return { now: () => clock.now, http };
}

/** A real local HTTP server standing in for an external system. */
export async function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void) {
  let hits = 0;
  const server = http.createServer((req, res) => handler(req, res, ++hits));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Every table except the vault and Prisma bookkeeping, as one big string, to prove a value is stored nowhere else. */
export async function dumpNonSecretTables(): Promise<string> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'IntegrationSecret')`;
  const parts: string[] = [];
  for (const { tablename } of tables) {
    const rows = await prisma.$queryRawUnsafe<{ j: string }[]>(`SELECT row_to_json(t)::text AS j FROM "${tablename}" t`);
    for (const r of rows) parts.push(r.j);
  }
  return parts.join("\n");
}

/** Wait for the real event loop (used by concurrency tests that need ordering between async steps). */
export const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

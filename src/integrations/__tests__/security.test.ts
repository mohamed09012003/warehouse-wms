// Secret-leakage prevention, failure isolation, data integrity under integration load, and architecture rules.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhookRoute } from "@/app/api/webhooks/[publicId]/route";
import { toErrorResponse } from "@/lib/errors";
import { adjustStock, createReservation, moveStock, receiveStock } from "@/modules/inventory";
import { addPackageItem, completePackage, completePacking, createPackage, startPacking } from "@/modules/packing";
import { allocateOrder, cancelOrder } from "@/modules/picking";
import { prisma, resetDatabase } from "../../../tests/support/db";
import {
  assertLedgerMatchesBalances,
  assertPackingInvariants,
  assertPickingInvariants,
  inventorySnapshot,
  makeOrder,
  makeProduct,
  newTenant,
  pickOrder,
  stockAt,
  tenantWithWarehouse,
} from "../../../tests/support/fixtures";
import { canary, dumpNonSecretTables, envelope, newIntegration, signedRequest, startServer, type TestIntegration } from "../../../tests/support/integrations";
import {
  createIntegration,
  deleteIntegrationSecret,
  disableIntegration,
  getInboundEvent,
  getIntegration,
  ingestWebhook,
  listDeliveries,
  listInboundEvents,
  listIntegrationLogs,
  listIntegrations,
  replayDelivery,
  replayInboundEvent,
  runOnce,
  setIntegrationSecret,
  testIntegration,
  updateIntegration,
} from "..";
import { defaultWorkerDeps } from "../service/workerDeps";

beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());

/** JSON.stringify that tolerates BigInt columns. */
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function captureConsole() {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
  return lines;
}

describe("a secret never leaves the vault", () => {
  it("canary secrets appear in no API response, error, console output, log row or ordinary table across a full lifecycle (including a hostile remote that echoes them)", async () => {
    const consoleLines = captureConsole();
    const t = await tenantWithWarehouse("cn", { bays: 2, levels: 1 });
    const prod = await makeProduct(t.ctx, "SKU-A");
    const outboundCanary = canary("OUT");
    const inboundCanary = canary("IN");
    const rotatedCanary = canary("ROT");
    const payloadMarker = canary("PAYLOAD");
    const apiReturns: unknown[] = [];
    const keep = <T>(v: T): T => (apiReturns.push(v), v);
    const thrown: unknown[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        keep(await fn());
      } catch (error) {
        thrown.push({ message: (error as Error).message, code: (error as { code?: string }).code, details: (error as { details?: unknown }).details });
        keep((await toErrorResponse(error).json()) as unknown);
      }
    };

    // the "external system": answers with whatever would hurt most if we stored or echoed it
    let mode: "echo500" | "echo401" | "ok" = "echo500";
    const remote = await startServer((req, res) => {
      req.resume();
      if (mode === "echo500") {
        res.writeHead(500, { "x-debug-secret": outboundCanary });
        res.end(`internal error: key=${outboundCanary} auth=${String(req.headers["x-wms-signature"])}`);
      } else if (mode === "echo401") {
        res.writeHead(401, { "www-authenticate": `Bearer ${outboundCanary}` });
        res.end(`bad credentials ${outboundCanary} ${inboundCanary}`);
      } else res.end("ok");
    });

    const dto = keep(await createIntegration(t.ctx, { name: "Hostile", provider: "generic-webhook", inboundEnabled: true, outboundEnabled: true, config: { targetUrl: `${remote.url}/hook`, subscribedEvents: ["order.created", "order.cancelled"], maxAttempts: 2 } }));
    keep(await setIntegrationSecret(t.ctx, dto.id, "inbound_signing_secret", { value: inboundCanary }));
    keep(await setIntegrationSecret(t.ctx, dto.id, "outbound_signing_secret", { value: outboundCanary }));
    keep(await setIntegrationSecret(t.ctx, dto.id, "inbound_signing_secret", { value: rotatedCanary })); // rotation keeps a PREVIOUS value
    await attempt(() => setIntegrationSecret(t.ctx, dto.id, "inbound_signing_secret", { value: "short" }));
    await attempt(() => updateIntegration(t.ctx, dto.id, { config: { apiKey: outboundCanary } }));
    await attempt(() => createIntegration(t.ctx, { name: "Hostile", provider: "generic-webhook" })); // duplicate name
    keep(await (await import("..")).enableIntegration(t.ctx, dto.id));
    const publicId = dto.webhookPath.split("/").pop()!;
    const integ: TestIntegration = { id: dto.id, publicId, inboundSecret: rotatedCanary, outboundSecret: outboundCanary };

    // inbound traffic: good, rejected-with-payload-marker, bad signature, malformed
    keep(await ingestWebhook(publicId, signedRequest(publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "SKU-X", name: "X" }))));
    keep(await ingestWebhook(publicId, signedRequest(publicId, integ.inboundSecret, envelope("not.supported", { note: payloadMarker }, "evt-marker"))));
    keep(await ingestWebhook(publicId, signedRequest(publicId, inboundCanary, envelope("product.upsert", { externalId: "P2", sku: "Y", name: "Y" })))); // the PREVIOUS secret: grace
    keep(await ingestWebhook(publicId, signedRequest(publicId, canary("WRONG"), envelope("product.upsert", {}))));
    keep(await ingestWebhook(publicId, signedRequest(publicId, integ.inboundSecret, "{garbage")));
    await attempt(async () => (await webhookRoute(signedRequest(publicId, integ.inboundSecret, "{bad"), { params: Promise.resolve({ publicId }) })).json());

    // outbound traffic against the hostile remote: retries, dead, replay, test event
    await makeOrder(t.ctx, [{ productId: prod.id, quantity: 1 }]);
    const deps = defaultWorkerDeps();
    await runOnce(deps);
    keep(await listDeliveries(t.ctx, dto.id));
    mode = "echo401";
    await attempt(() => testIntegration(t.ctx, dto.id));
    keep(await testIntegration(t.ctx, dto.id).catch((e) => ({ failed: (e as Error).message })));
    const dead = await prisma.integrationDelivery.findFirst({ where: { integrationId: dto.id } });
    await prisma.integrationDelivery.updateMany({ data: { nextAttemptAt: new Date(0) } });
    await runOnce(deps);
    mode = "ok";
    if (dead) await attempt(() => replayDelivery(t.ctx, dto.id, dead.id));
    await runOnce(deps);

    // reads of everything an admin can see
    keep(await getIntegration(t.ctx, dto.id));
    keep(await listIntegrations(t.ctx));
    keep(await listDeliveries(t.ctx, dto.id));
    keep(await listInboundEvents(t.ctx, dto.id));
    keep(await listIntegrationLogs(t.ctx, dto.id, { limit: 200 }));
    const events = await prisma.inboundEvent.findMany({ where: { integrationId: dto.id } });
    for (const e of events) keep(await getInboundEvent(t.ctx, dto.id, e.id).catch(() => null));
    await disableIntegration(t.ctx, dto.id);
    await attempt(() => deleteIntegrationSecret(t.ctx, dto.id, "outbound_signing_secret"));
    await attempt(() => replayInboundEvent(t.ctx, dto.id, events[0].id));
    await remote.close();

    // --- the assertions: no secret anywhere it must not be ---------------------------------------
    const secrets = [outboundCanary, inboundCanary, rotatedCanary];
    const where: Record<string, string> = {
      "API responses": JSON.stringify(apiReturns),
      "thrown errors": JSON.stringify(thrown),
      "console output": consoleLines.join("\n"),
      "IntegrationLog rows": JSON.stringify(await prisma.integrationLog.findMany()),
      "ordinary tables": await dumpNonSecretTables(),
    };
    for (const [place, text] of Object.entries(where)) {
      expect(text.length, place).toBeGreaterThan(50);
      for (const s of secrets) expect(text, `${place} must not contain ${s.slice(0, 12)}…`).not.toContain(s);
    }
    // the remote's response body/headers were never stored either
    for (const text of [where["IntegrationLog rows"], where["ordinary tables"], where["console output"]]) {
      expect(text).not.toContain("internal error: key=");
      expect(text).not.toContain("bad credentials");
    }
    // the webhook PAYLOAD lives only in InboundEvent.payload (and its admin detail view), never in logs or events
    expect(where["IntegrationLog rows"]).not.toContain(payloadMarker);
    expect(where["console output"]).not.toContain(payloadMarker);
    expect(json(await prisma.outboxEvent.findMany())).not.toContain(payloadMarker);
    expect(JSON.stringify(await listInboundEvents(t.ctx, dto.id))).not.toContain(payloadMarker); // lists never carry payloads
    expect(JSON.stringify(await prisma.integration.findMany())).not.toContain(payloadMarker);
    // and the vault holds ciphertext only
    for (const row of await prisma.integrationSecret.findMany()) for (const s of secrets) expect(Buffer.from(row.ciphertext).includes(Buffer.from(s))).toBe(false);
  });

  it("the stored error summary of a failed delivery is a code and a short sentence, never the remote's text", async () => {
    captureConsole();
    const t = await tenantWithWarehouse("er", { bays: 1, levels: 1 });
    const prod = await makeProduct(t.ctx, "SKU-A");
    const remote = await startServer((req, res) => {
      req.resume();
      res.writeHead(503, { "retry-after": "5" });
      res.end("SECRET-REMOTE-BODY-TEXT stack trace at /srv/app.js postgresql://u:p@db/x");
    });
    const integ = await newIntegration(t.ctx, { inbound: false, outbound: true, targetUrl: `${remote.url}/hook`, events: ["order.created"] });
    await makeOrder(t.ctx, [{ productId: prod.id, quantity: 1 }]);
    await runOnce(defaultWorkerDeps());
    await remote.close();
    const d = await prisma.integrationDelivery.findFirstOrThrow({ where: { integrationId: integ.id } });
    expect(d).toMatchObject({ status: "FAILED", lastErrorCode: "HTTP_503", lastHttpStatus: 503 });
    expect(d.lastErrorSummary).toBe("Target responded with HTTP 503");
    expect(JSON.stringify([d, await prisma.integrationLog.findMany(), await prisma.integration.findMany()])).not.toMatch(/SECRET-REMOTE|stack trace|postgresql:/);
  });

  it("5xx responses carry only a correlation id; the log line has the code and the same id but never the error message", async () => {
    const lines = captureConsole();
    const message = "connection to postgresql://svc:Hunter2@db/prod failed: SELECT secret FROM x";
    const res = toErrorResponse(Object.assign(new Error(message), { code: "P2024" }));
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toMatch(/Hunter2|SELECT|postgresql/);
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    const logged = lines.join("\n");
    expect(logged).not.toMatch(/Hunter2|SELECT|postgresql|connection to/);
    expect(logged).toContain(body.error.correlationId);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "error", event: "request.failed", code: "DATABASE_ERROR", prismaCode: "P2024", errorClass: "Error" });

    const plain = toErrorResponse(new Error("boom secret"));
    expect(JSON.stringify(await plain.json())).not.toContain("boom secret");
    expect(lines.join("\n")).not.toContain("boom secret");
    // client errors stay informative and carry no correlation id
    const clientError = await toErrorResponse(new (await import("@/lib/errors")).ValidationError("Name is required")).json();
    expect(clientError.error.message).toBe("Name is required");
    expect(clientError.error.correlationId).toBeUndefined();
  });

  it("the webhook route answers JSON with no-store and never reveals why authentication failed", async () => {
    const t = await newTenant("rt");
    const integ = await newIntegration(t.ctx);
    const call = (req: Request, id = integ.publicId) => webhookRoute(req, { params: Promise.resolve({ publicId: id }) });
    const ok = await call(signedRequest(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "A", name: "A" })));
    expect(ok.status).toBe(202);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("content-type")).toContain("application/json");
    const unknown = await call(signedRequest("A".repeat(22), "x".repeat(20), {}), "A".repeat(22));
    const wrong = await call(signedRequest(integ.publicId, "w".repeat(20), envelope("product.upsert", {})));
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
  });
});

describe("integrations never block or corrupt the WMS", () => {
  it("receive, move, reserve, adjust, allocate, pick, pack and cancel all work while every integration is failing, disabled, paused or unreachable", async () => {
    captureConsole();
    const t = await tenantWithWarehouse("fi", { bays: 3, levels: 1 });
    const prod = await makeProduct(t.ctx, "SKU-A");
    const P1 = t.byCode("R01-L01-B01-P01");
    const P2 = t.byCode("R01-L01-B02-P01");

    // 1. an outbound target that never answers (would hang a synchronous call forever)
    const hang = await startServer(() => undefined);
    const hanging = await newIntegration(t.ctx, { name: "hangs", inbound: false, outbound: true, targetUrl: `${hang.url}/hook`, events: ["order.created", "order.allocated", "order.picked", "order.packed", "order.cancelled"] });
    // 2. a target that refuses connections
    const refused = await startServer((_q, res) => res.end());
    const refusedUrl = refused.url;
    await refused.close();
    await newIntegration(t.ctx, { name: "refuses", inbound: false, outbound: true, targetUrl: `${refusedUrl}/hook`, events: ["order.created", "order.allocated", "order.picked", "order.packed", "order.cancelled"] });
    // 3. a paused one and a disabled one
    const paused = await newIntegration(t.ctx, { name: "paused", inbound: false, outbound: true, targetUrl: `${refusedUrl}/hook`, events: ["order.created"] });
    await prisma.integration.update({ where: { id: paused.id }, data: { outboundPausedAt: new Date(), outboundHealthStatus: "FAILING", outboundConsecutiveFailures: 25 } });
    const off = await newIntegration(t.ctx, { name: "off", inbound: false, outbound: true, targetUrl: `${refusedUrl}/hook`, events: ["order.created"], enable: false });
    void off;

    const started = Date.now();
    // stock operations
    await receiveStock(t.ctx, { productId: prod.id, positionId: P1.id, quantity: 50 });
    await moveStock(t.ctx, { productId: prod.id, fromPositionId: P1.id, toPositionId: P2.id, quantity: 10 });
    await adjustStock(t.ctx, { productId: prod.id, positionId: P2.id, delta: 5, reason: "count" });
    const reservation = await createReservation(t.ctx, { lines: [{ productId: prod.id, positionId: P2.id, quantity: 3 }] });
    expect(reservation.operationId).toBeTruthy();
    // order flow: allocate, pick, pack, cancel
    const full = await makeOrder(t.ctx, [{ productId: prod.id, quantity: 12 }]);
    await pickOrder(t.ctx, full.id);
    const s = await startPacking(t.ctx, { orderId: full.id });
    const pkg = await createPackage(t.ctx, { sessionId: s.session.id });
    await addPackageItem(t.ctx, { packageId: pkg.packageId!, productCode: "SKU-A", quantity: 12 });
    await completePackage(t.ctx, { packageId: pkg.packageId! });
    await completePacking(t.ctx, { sessionId: s.session.id });
    const toCancel = await makeOrder(t.ctx, [{ productId: prod.id, quantity: 4 }]);
    await allocateOrder(t.ctx, { orderId: toCancel.id });
    await cancelOrder(t.ctx, { orderId: toCancel.id });
    const elapsed = Date.now() - started;

    expect((await prisma.order.findUniqueOrThrow({ where: { id: full.id } })).status).toBe("PACKED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: toCancel.id } })).status).toBe("CANCELLED");
    expect(hang.hits()).toBe(0); // no worker ran, and core operations never contact an integration
    expect(elapsed).toBeLessThan(15_000); // nothing waited for a 10 s timeout
    expect((await prisma.outboxEvent.findMany()).map((e) => e.eventType).sort()).toEqual(["order.allocated", "order.allocated", "order.cancelled", "order.created", "order.created", "order.packed", "order.picked"]);
    await assertLedgerMatchesBalances();
    await assertPickingInvariants();
    await assertPackingInvariants();

    // 4. the worker itself failing (timeouts, refusals) does not change any WMS state
    const before = await inventorySnapshot();
    const orderStatuses = JSON.stringify(await prisma.order.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } }));
    const fast = { now: () => new Date(), http: (await import("../http/safeHttpClient")).createSafeHttpClient({ allowPrivateTargets: true, timeoutMs: 250 }) };
    const summary = await runOnce(fast, { maxItems: 100 });
    expect(summary.deliveries.succeeded).toBe(0);
    expect(summary.deliveries.failed + summary.deliveries.dead).toBeGreaterThan(0);
    expect(await inventorySnapshot()).toBe(before);
    expect(JSON.stringify(await prisma.order.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true } }))).toBe(orderStatuses);
    expect(hang.hits()).toBeGreaterThan(0); // the worker did try the hanging target, and timed out
    expect((await prisma.integrationDelivery.findFirst({ where: { integrationId: hanging.id } }))!.lastErrorCode).toBe("TIMEOUT");
    await hang.close();
    await assertLedgerMatchesBalances();
  });

  it("an inbound storm racing with picking and packing keeps stock, orders and packages consistent", async () => {
    captureConsole();
    const t = await tenantWithWarehouse("st", { bays: 3, levels: 1 });
    const prod = await makeProduct(t.ctx, "SKU-A");
    await stockAt(t.ctx, prod.id, t.byCode("R01-L01-B01-P01").id, 100);
    const integ = await newIntegration(t.ctx);
    const other = await tenantWithWarehouse("st2", { bays: 1, levels: 1 });
    const otherProd = await makeProduct(other.ctx, "SKU-A");
    await stockAt(other.ctx, otherProd.id, other.byCode("R01-L01-B01-P01").id, 20);
    const otherInteg = await newIntegration(other.ctx);

    const send = async (i: TestIntegration, type: string, data: Record<string, unknown>) => {
      const res = await ingestWebhook(i.publicId, signedRequest(i.publicId, i.inboundSecret, envelope(type, data)));
      expect([200, 202]).toContain(res.status);
    };
    await send(integ, "product.upsert", { externalId: "P", sku: "SKU-A", name: "A" });
    await send(otherInteg, "product.upsert", { externalId: "P", sku: "SKU-A", name: "A" });
    for (let i = 1; i <= 10; i++) await send(integ, "order.create", { externalId: `o-${i}`, lines: [{ externalProductId: "P", quantity: 2 }] });
    for (let i = 1; i <= 4; i++) await send(otherInteg, "order.create", { externalId: `o-${i}`, lines: [{ externalProductId: "P", quantity: 1 }] });
    const deps = defaultWorkerDeps();
    await Promise.all([runOnce(deps, { maxItems: 100 }), runOnce(deps, { maxItems: 100 })]);
    const orders = await prisma.order.findMany({ where: { organizationId: t.ctx.organizationId }, orderBy: { orderNumber: "asc" } });
    expect(orders).toHaveLength(10);
    const byExt = new Map(orders.map((o) => [o.externalRef!, o.id]));

    // allocate orders 1-5 through the core, then race their cancellation (events) against picking/packing orders 6-10
    for (let i = 1; i <= 5; i++) await allocateOrder(t.ctx, { orderId: byExt.get(`o-${i}`)! });
    for (let i = 1; i <= 5; i++) await send(integ, "order.cancel", { externalId: `o-${i}` });
    for (let i = 1; i <= 4; i++) await send(otherInteg, "order.cancel", { externalId: `o-${i}` });
    const workers = Promise.all(Array.from({ length: 3 }, () => runOnce(deps, { maxItems: 100 })));
    const picking = (async () => {
      for (let i = 6; i <= 10; i++) {
        const orderId = byExt.get(`o-${i}`)!;
        await pickOrder(t.ctx, orderId);
        const s = await startPacking(t.ctx, { orderId });
        const p = await createPackage(t.ctx, { sessionId: s.session.id });
        await addPackageItem(t.ctx, { packageId: p.packageId!, productCode: "SKU-A", quantity: 2 });
        await completePackage(t.ctx, { packageId: p.packageId! });
        await completePacking(t.ctx, { sessionId: s.session.id });
      }
    })();
    await Promise.all([workers, picking]);
    await runOnce(deps, { maxItems: 100 });

    expect(await prisma.inboundEvent.count({ where: { status: { in: ["RECEIVED", "PROCESSING", "FAILED"] } } })).toBe(0);
    expect(await prisma.inboundEvent.count({ where: { status: { in: ["REJECTED", "DEAD"] } } })).toBe(0);
    const statuses = await prisma.order.findMany({ where: { organizationId: t.ctx.organizationId }, select: { externalRef: true, status: true } });
    for (const o of statuses) expect(o.status, o.externalRef!).toBe(Number(o.externalRef!.split("-")[1]) <= 5 ? "CANCELLED" : "PACKED");
    expect(await prisma.order.count({ where: { organizationId: other.ctx.organizationId, status: "CANCELLED" } })).toBe(4);
    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { organizationId: t.ctx.organizationId } });
    expect([balance.onHand, balance.reserved]).toEqual([90, 0]); // 100 - 5 orders x 2 picked; cancelled orders released everything
    await assertLedgerMatchesBalances();
    await assertPickingInvariants();
    await assertPackingInvariants();
    // exactly one event per transition
    const count = (type: string) => prisma.outboxEvent.count({ where: { organizationId: t.ctx.organizationId, eventType: type } });
    expect([await count("order.created"), await count("order.cancelled"), await count("order.picked"), await count("order.packed")]).toEqual([10, 5, 5, 5]);
    // tenant B was never touched by tenant A's integration
    expect(await prisma.order.count({ where: { organizationId: other.ctx.organizationId } })).toBe(4);
    expect(await prisma.externalRef.count({ where: { organizationId: other.ctx.organizationId, entityType: "ORDER" } })).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------------
describe("architecture rules", () => {
  const walk = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true }) as string[])
      .map((f) => path.join(dir, f))
      .filter((f) => /\.(ts|tsx)$/.test(f) && fs.statSync(f).isFile() && !f.includes("__tests__") && !f.includes(`${path.sep}generated${path.sep}`));
  const code = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const rel = (f: string) => path.relative(process.cwd(), f).replace(/\\/g, "/");

  it("the WMS core never imports the integration layer", () => {
    const offenders = [...walk(path.resolve("src/modules")), ...walk(path.resolve("src/server")), ...walk(path.resolve("src/lib"))].filter((f) => /from\s+["'][^"']*integrations[^"']*["']/.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("the integration layer reaches the core only through module public APIs", () => {
    const deep = walk(path.resolve("src/integrations")).flatMap((f) => (code(f).match(/from\s+["']@\/modules\/[a-z]+\/[^"']+["']/g) ?? []).map((m) => `${rel(f)}: ${m}`));
    expect(deep).toEqual([]);
  });

  it("the integration layer never touches inventory, reservation, pick or packing tables or their repositories", () => {
    const forbidden = /\b(inventoryBalance|inventoryMovement|inventoryOperation|reservationLine|reservation|pickTask|pickingWave|packingSession|packageItem|packingEvent)\b/i;
    const offenders = walk(path.resolve("src/integrations")).filter((f) => forbidden.test(code(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("only repositories and the secret store use the raw Prisma client inside the integration layer", () => {
    const uses = walk(path.resolve("src/integrations")).filter((f) => /@\/server\/db\/client|@\/generated\/prisma/.test(code(f))).map((f) => rel(f));
    for (const f of uses) expect(f, f).toMatch(/src\/integrations\/(repo\/|secrets\/secretStore\.ts)/);
  });

  it("no secrets are committed: .env.example holds placeholders only", () => {
    const example = fs.readFileSync(".env.example", "utf8");
    expect(example).toContain("INTEGRATION_ENCRYPTION_KEYS");
    expect(example).not.toMatch(/INTEGRATION_ENCRYPTION_KEYS="[^"]*[A-Za-z0-9+/]{43}=/);
    expect(example).toMatch(/REPLACE_WITH/);
  });
});

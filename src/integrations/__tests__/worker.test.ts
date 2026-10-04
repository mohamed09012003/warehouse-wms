// The worker: outbox fan-out, outbound delivery (success, retry, dead), leases, concurrent workers,
// circuit breaker, replay and retention. Time is controlled through an injected clock; the network is a fake.
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { makeOrder, makeProduct, tenantWithWarehouse } from "../../../tests/support/fixtures";
import { advance, clockAt, depsFor, FakeHttp, newIntegration, type Clock } from "../../../tests/support/integrations";
import { enableIntegration, replayDelivery, runOnce, testIntegration, updateIntegration } from "..";
import { verifySignature } from "../adapters/generic-webhook";
import { BACKOFF_SCHEDULE_MS } from "../core/retry";
import { HttpClientError, type HttpResponse } from "../core/types";
import { deliveryRepo } from "../repo/deliveryRepo";
import { fanoutRepo, RETENTION } from "../repo/fanoutRepo";
import { processDelivery } from "../service/deliveryProcessor";
import { fanOutOutbox } from "../service/fanout";

beforeEach(resetDatabase);

const ALL_EVENTS = ["order.created", "order.allocated", "order.picked", "order.packed", "order.cancelled"];
const TARGET = "https://hooks.example.test/wms";

async function setup(opts: { events?: string[]; maxAttempts?: number } = {}) {
  const t = await tenantWithWarehouse("wk", { bays: 2, levels: 1 });
  const prod = await makeProduct(t.ctx, "SKU-A");
  const integ = await newIntegration(t.ctx, { inbound: false, outbound: true, targetUrl: TARGET, events: opts.events ?? ALL_EVENTS, maxAttempts: opts.maxAttempts });
  const clock = clockAt(new Date().toISOString());
  const order = (qty = 1) => makeOrder(t.ctx, [{ productId: prod.id, quantity: qty }]);
  return { ...t, prod, integ, clock, order };
}

const pass = (clock: Clock, http: FakeHttp, options?: Parameters<typeof runOnce>[1]) => runOnce(depsFor(clock, http), options);
const deliveries = () => prisma.integrationDelivery.findMany({ orderBy: { createdAt: "asc" } });
const respond = (status: number, headers: Record<string, string> = {}): HttpResponse => ({ status, headers });

describe("fan-out", () => {
  it("creates one delivery per subscribed, enabled outbound integration and marks the event fanned out", async () => {
    const { ctx, integ, clock, order } = await setup({ events: ["order.created"] });
    const second = await newIntegration(ctx, { name: "other", inbound: false, outbound: true, targetUrl: TARGET, events: ["order.created", "order.cancelled"] });
    const silent = await newIntegration(ctx, { name: "silent", inbound: false, outbound: true, targetUrl: TARGET, events: ["order.packed"] });
    await newIntegration(ctx, { name: "inbound only" });
    await order();

    const summary = await pass(clock, new FakeHttp(() => respond(500)));
    expect(summary.fannedOutEvents).toBe(1);
    expect(summary.deliveriesCreated).toBe(2);
    const rows = await deliveries();
    expect(rows.map((r) => r.integrationId).sort()).toEqual([integ.id, second.id].sort());
    expect(rows.some((r) => r.integrationId === silent.id)).toBe(false);
    expect((await prisma.outboxEvent.findFirstOrThrow()).fannedOutAt).not.toBeNull();
  });

  it("does not deliver across organizations", async () => {
    const a = await setup();
    const b = await tenantWithWarehouse("wk2", { bays: 1, levels: 1 });
    const prodB = await makeProduct(b.ctx, "SKU-B");
    const integB = await newIntegration(b.ctx, { inbound: false, outbound: true, targetUrl: TARGET, events: ALL_EVENTS });
    await a.order();
    await makeOrder(b.ctx, [{ productId: prodB.id, quantity: 1 }]);
    const http = new FakeHttp();
    await pass(a.clock, http);
    const rows = await deliveries();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const ev = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: r.outboxEventId } });
      expect(ev.organizationId).toBe(r.organizationId);
    }
    expect(rows.find((r) => r.integrationId === integB.id)!.organizationId).toBe(b.ctx.organizationId);
  });

  it("skips disabled and archived integrations, but still queues for a paused one", async () => {
    const { ctx, integ, clock, order } = await setup();
    const archived = await newIntegration(ctx, { name: "arch", inbound: false, outbound: true, targetUrl: TARGET, events: ALL_EVENTS });
    await updateIntegration(ctx, archived.id, { archived: true });
    const paused = await newIntegration(ctx, { name: "paused", inbound: false, outbound: true, targetUrl: TARGET, events: ALL_EVENTS });
    await prisma.integration.update({ where: { id: paused.id }, data: { outboundPausedAt: new Date() } });
    await prisma.integration.update({ where: { id: integ.id }, data: { enabled: false, disabledReason: "off" } });
    await order();
    await pass(clock, new FakeHttp());
    const rows = await deliveries();
    expect(rows.map((r) => r.integrationId)).toEqual([paused.id]);
    expect(rows[0].status).toBe("PENDING"); // queued, but a paused integration is never claimed
  });

  it("is idempotent: a repeated fan-out cannot create a second delivery", async () => {
    const { ctx, integ, clock, order } = await setup();
    await order();
    await pass(clock, new FakeHttp(() => respond(500)));
    const event = await prisma.outboxEvent.findFirstOrThrow();
    const again = await fanoutRepo.createDeliveries(prisma, [{ organizationId: ctx.organizationId, integrationId: integ.id, outboxEventId: event.id }], clock.now);
    expect(again).toBe(0);
    expect(await prisma.integrationDelivery.count()).toBe(1);
    await expect(prisma.integrationDelivery.create({ data: { organizationId: ctx.organizationId, integrationId: integ.id, outboxEventId: event.id } })).rejects.toMatchObject({ code: "P2002" });
  });

  it("concurrent workers fan every event out exactly once", async () => {
    const { ctx, integ, clock, order } = await setup();
    const second = await newIntegration(ctx, { name: "second", inbound: false, outbound: true, targetUrl: TARGET, events: ALL_EVENTS });
    for (let i = 0; i < 12; i++) await order();
    const deps = depsFor(clock, new FakeHttp());
    const results = await Promise.all(Array.from({ length: 4 }, () => fanOutOutbox(deps, 5)));
    expect(results.reduce((n, r) => n + r.events, 0)).toBe(12);
    expect(await prisma.integrationDelivery.count()).toBe(24);
    expect(await prisma.integrationDelivery.count({ where: { integrationId: integ.id } })).toBe(12);
    expect(await prisma.integrationDelivery.count({ where: { integrationId: second.id } })).toBe(12);
    expect(await prisma.outboxEvent.count({ where: { fannedOutAt: null } })).toBe(0);
  });
});

describe("delivery", () => {
  it("sends the event once as signed JSON with stable ids, and records success", async () => {
    const { integ, clock, order } = await setup();
    const o = await order(3);
    const http = new FakeHttp();
    const summary = await pass(clock, http);
    expect(summary.deliveries.succeeded).toBe(1);
    expect(http.requests).toHaveLength(1);

    const req = http.requests[0];
    const event = await prisma.outboxEvent.findFirstOrThrow();
    expect(req.url).toBe(TARGET);
    expect(req.method).toBe("POST");
    expect(req.headers).toMatchObject({ "Content-Type": "application/json", "X-WMS-Event-Id": event.id, "X-WMS-Event-Type": "order.created", "X-WMS-Attempt": "1" });
    expect(req.headers["X-WMS-Delivery-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(req.body)).toMatchObject({ eventId: event.id, type: "order.created", schemaVersion: 1, data: { orderId: o.id, orderNumber: o.orderNumber } });
    expect(verifySignature({ header: req.headers["X-WMS-Signature"], rawBody: req.body, secrets: [integ.outboundSecret], now: clock.now })).toBe("ok");
    // nothing but the documented headers; no secret anywhere in what was sent
    expect(Object.keys(req.headers).sort()).toEqual(["Content-Type", "User-Agent", "X-WMS-Attempt", "X-WMS-Delivery-Id", "X-WMS-Event-Id", "X-WMS-Event-Type", "X-WMS-Signature"]);
    expect(JSON.stringify(req)).not.toContain(integ.outboundSecret);
    expect(JSON.stringify(req)).not.toContain(integ.inboundSecret);

    const d = (await deliveries())[0];
    expect(d).toMatchObject({ status: "SUCCEEDED", attempts: 1, lastHttpStatus: 200, lastErrorCode: null });
    expect(d.deliveredAt).not.toBeNull();
    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row).toMatchObject({ outboundHealthStatus: "HEALTHY", outboundConsecutiveFailures: 0 });
    expect(row.outboundLastSuccessAt).not.toBeNull();
    const log = await prisma.integrationLog.findFirstOrThrow({ where: { integrationId: integ.id, status: "SUCCEEDED" } });
    expect(log).toMatchObject({ direction: "OUTBOUND", deliveryId: d.id, eventId: event.id, eventType: "order.created", attempt: 1, httpStatus: 200 });

    // nothing more to do on the next pass
    expect((await pass(clock, http)).deliveries).toEqual({ succeeded: 0, failed: 0, dead: 0, lease_lost: 0 });
    expect(http.requests).toHaveLength(1);
  });

  it("keeps the event id across retries and gives every attempt its own delivery id and attempt number", async () => {
    const { clock, order } = await setup();
    await order();
    const http = new FakeHttp((_r, i) => (i === 0 ? respond(503) : respond(200)));
    await pass(clock, http);
    expect((await deliveries())[0]).toMatchObject({ status: "FAILED", attempts: 1, lastHttpStatus: 503, lastErrorCode: "HTTP_503" });
    advance(clock, 30_000);
    await pass(clock, http);
    expect((await deliveries())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    const [first, second] = http.requests;
    expect(second.headers["X-WMS-Event-Id"]).toBe(first.headers["X-WMS-Event-Id"]);
    expect(second.headers["X-WMS-Delivery-Id"]).not.toBe(first.headers["X-WMS-Delivery-Id"]);
    expect([first.headers["X-WMS-Attempt"], second.headers["X-WMS-Attempt"]]).toEqual(["1", "2"]);
  });

  // One test per case (each needs a fresh tenant), so a slow machine cannot hit the per-test timeout.
  const retryCases: [string, (clock: Clock) => HttpResponse | Error, number, string][] = [
      ["500", () => respond(500), 30_000, "HTTP_500"],
      ["502", () => respond(502), 30_000, "HTTP_502"],
      ["408", () => respond(408), 30_000, "HTTP_408"],
      ["429", () => respond(429), 30_000, "HTTP_429"],
      ["429 + Retry-After 120", () => respond(429, { "retry-after": "120" }), 120_000, "HTTP_429"],
      ["503 + Retry-After 999999", () => respond(503, { "retry-after": "999999" }), 3_600_000, "HTTP_503"],
      ["timeout", () => new HttpClientError("TIMEOUT", "The request timed out"), 30_000, "TIMEOUT"],
      ["connection failed", () => new HttpClientError("CONNECTION_FAILED", "Could not connect to the target"), 30_000, "CONNECTION_FAILED"],
      ["dns", () => new HttpClientError("DNS_FAILED", "The target host name could not be resolved"), 30_000, "DNS_FAILED"],
      ["response too large", () => new HttpClientError("RESPONSE_TOO_LARGE", "The response was larger than the allowed size"), 30_000, "RESPONSE_TOO_LARGE"],
      ["adapter crash", () => new Error("boom with postgresql://u:p@h/db inside"), 30_000, "DELIVERY_ERROR"],
  ];

  it.each(retryCases)("retries after %s (Retry-After honoured but capped at one hour)", async (label, answer, delayMs, code) => {
      const { clock, order } = await setup();
      await order();
      const http = new FakeHttp(() => {
        const a = answer(clock);
        if (a instanceof Error) throw a;
        return a;
      });
      await pass(clock, http);
      const d = (await deliveries())[0];
      expect(d, label).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: code });
      expect(d.nextAttemptAt.getTime() - clock.now.getTime(), label).toBe(delayMs);
      expect(d.lastErrorSummary ?? "", label).not.toMatch(/postgresql:|u:p@/);
  });

  it("does not retry before the retry time, and does once it is due", async () => {
    const { clock, order } = await setup();
    await order();
    const http = new FakeHttp(() => respond(500));
    await pass(clock, http);
    advance(clock, 29_000);
    await pass(clock, http);
    expect(http.requests).toHaveLength(1);
    advance(clock, 1_000);
    await pass(clock, http);
    expect(http.requests).toHaveLength(2);
  });

  const deadCases: [string, HttpResponse | Error, string][] = [
      ["400", respond(400), "HTTP_400"],
      ["401", respond(401), "HTTP_401"],
      ["404", respond(404), "HTTP_404"],
      ["410", respond(410), "HTTP_410"],
      ["301 redirect", respond(301, { location: "http://169.254.169.254/" }), "REDIRECT_NOT_FOLLOWED"],
      ["302 redirect", respond(302), "REDIRECT_NOT_FOLLOWED"],
      ["blocked address", new HttpClientError("TARGET_NOT_ALLOWED", "The target address is not allowed"), "TARGET_NOT_ALLOWED"],
      ["invalid url", new HttpClientError("INVALID_URL", "Only https targets are allowed"), "INVALID_URL"],
  ];

  it.each(deadCases)("gives up immediately (DEAD) on %s, without retrying", async (label, answer, code) => {
      const { clock, order } = await setup();
      await order();
      const http = new FakeHttp(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const summary = await pass(clock, http);
      expect(summary.deliveries.dead, label).toBe(1);
      expect((await deliveries())[0], label).toMatchObject({ status: "DEAD", attempts: 1, lastErrorCode: code });
      advance(clock, 24 * 3600 * 1000);
      await pass(clock, http);
      expect(http.requests, label).toHaveLength(1); // never retried
  });

  it("follows the documented backoff schedule and goes DEAD after the 8th attempt", async () => {
    const { clock, order, integ } = await setup();
    await order();
    const http = new FakeHttp(() => respond(500));
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 8; attempt++) {
      await pass(clock, http);
      const d = (await deliveries())[0];
      expect(d.attempts).toBe(attempt);
      if (attempt < 8) {
        expect(d.status).toBe("FAILED");
        delays.push(d.nextAttemptAt.getTime() - clock.now.getTime());
        advance(clock, delays[delays.length - 1]);
      } else {
        expect(d.status).toBe("DEAD");
      }
    }
    expect(delays).toEqual([...BACKOFF_SCHEDULE_MS]); // 30s, 2m, 10m, 30m, 2h, 6h, 12h
    expect(http.requests).toHaveLength(8);
    advance(clock, 48 * 3600 * 1000);
    await pass(clock, http);
    expect(http.requests).toHaveLength(8); // DEAD stays dead
    const logs = await prisma.integrationLog.findMany({ where: { integrationId: integ.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.status).filter((s) => s !== "PAUSED")).toEqual([...Array(7).fill("RETRY_SCHEDULED"), "DEAD"]);
  });

  it("honours a per-integration attempt limit (bounded 1-12)", async () => {
    const { clock, order } = await setup({ maxAttempts: 3 });
    await order();
    const http = new FakeHttp(() => respond(500));
    for (let i = 0; i < 6; i++) {
      await pass(clock, http);
      advance(clock, 13 * 3600 * 1000);
    }
    expect(http.requests).toHaveLength(3);
    expect((await deliveries())[0]).toMatchObject({ status: "DEAD", attempts: 3 });
  });

  it("replay puts a dead delivery back in the queue with a fresh budget; successful ones cannot be replayed", async () => {
    const { ctx, integ, clock, order } = await setup();
    await order();
    let up = false;
    const http = new FakeHttp(() => (up ? respond(200) : respond(404)));
    await pass(clock, http);
    const dead = (await deliveries())[0];
    expect(dead.status).toBe("DEAD");

    up = true;
    const refreshed = await replayDelivery(ctx, integ.id, dead.id);
    advance(clock, 5_000); // replay stamps the real time; the test clock must catch up
    expect(refreshed[0]).toMatchObject({ id: dead.id, status: "PENDING", attempts: 0, lastErrorCode: null });
    await pass(clock, http);
    expect((await deliveries())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(http.requests.at(-1)!.headers["X-WMS-Event-Id"]).toBe(http.requests[0].headers["X-WMS-Event-Id"]); // same stable event id

    await expect(replayDelivery(ctx, integ.id, dead.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await prisma.integrationLog.findMany({ where: { status: "REPLAYED" } })).length).toBe(1);
  });
});

describe("leases and recovery", () => {
  it("reclaims a delivery whose worker vanished and finishes it (the event id stays the same)", async () => {
    const { clock, order, integ } = await setup();
    await order();
    const http = new FakeHttp();
    await fanOutOutbox(depsFor(clock, http));
    const [claimed] = await deliveryRepo.claim(clock.now, 1); // ... and the worker dies here
    expect(claimed.attempts).toBe(1);

    advance(clock, 30_000);
    const early = await pass(clock, http);
    expect(early.reapedDeliveries).toBe(0); // lease (60 s) still valid
    expect(http.requests).toHaveLength(0);

    advance(clock, 31_000);
    const late = await pass(clock, http);
    expect(late.reapedDeliveries).toBe(1);
    expect(late.deliveries.succeeded).toBe(1);
    expect((await deliveries())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "LEASE_EXPIRED" } })).toBe(1);
  });

  it("goes DEAD when the lease expires on the last allowed attempt", async () => {
    const { clock, order } = await setup({ maxAttempts: 1 });
    await order();
    const http = new FakeHttp();
    await fanOutOutbox(depsFor(clock, http));
    await deliveryRepo.claim(clock.now, 1);
    advance(clock, 61_000);
    const summary = await pass(clock, http);
    expect(summary.reapedDeliveries).toBe(1);
    expect(http.requests).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ status: "DEAD", lastErrorCode: "LEASE_EXPIRED" });
  });

  it("a worker that lost its lease cannot overwrite the new owner's outcome", async () => {
    const { clock, order } = await setup();
    await order();
    const http = new FakeHttp();
    await fanOutOutbox(depsFor(clock, http));
    const [stale] = await deliveryRepo.claim(clock.now, 1);
    advance(clock, 61_000);
    await pass(clock, http); // reaped, reclaimed and delivered by "another worker"
    expect((await deliveries())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    const logsBefore = await prisma.integrationLog.count();

    expect(await processDelivery(stale, depsFor(clock, http))).toBe("lease_lost");
    expect((await deliveries())[0]).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await prisma.integrationLog.count()).toBe(logsBefore);
    // at-least-once: the late worker may have sent a duplicate, but with the SAME stable event id
    expect(new Set(http.requests.map((r) => r.headers["X-WMS-Event-Id"])).size).toBe(1);
  });
});

describe("concurrent workers", () => {
  it("claims never overlap (FOR UPDATE SKIP LOCKED)", async () => {
    const { clock, order } = await setup();
    for (let i = 0; i < 20; i++) await order();
    await fanOutOutbox(depsFor(clock, new FakeHttp()), 100);
    const batches = await Promise.all(Array.from({ length: 5 }, () => deliveryRepo.claim(clock.now, 8)));
    const ids = batches.flat().map((c) => c.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(await prisma.integrationDelivery.count({ where: { status: "PROCESSING", attempts: 1 } })).toBe(20);
  });

  it("several workers deliver every event exactly once", async () => {
    const { clock, order } = await setup();
    for (let i = 0; i < 24; i++) await order();
    const http = new FakeHttp();
    await Promise.all(Array.from({ length: 4 }, () => pass(clock, http, { maxItems: 100 })));
    const ids = http.requests.map((r) => r.headers["X-WMS-Event-Id"]);
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(24); // no event sent twice
    expect(await prisma.integrationDelivery.count({ where: { status: "SUCCEEDED", attempts: 1 } })).toBe(24);
  });
});

describe("health and the circuit breaker", () => {
  it("degrades after 3 consecutive failures and recovers on a success", async () => {
    const { clock, order, integ } = await setup();
    for (let i = 0; i < 3; i++) await order();
    let ok = false;
    const http = new FakeHttp(() => (ok ? respond(200) : respond(500)));
    await pass(clock, http, { maxItems: 2 }); // 2 failures
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).outboundHealthStatus).toBe("HEALTHY");
    await pass(clock, http, { maxItems: 1 }); // third failure
    const degraded = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(degraded).toMatchObject({ outboundHealthStatus: "DEGRADED", outboundConsecutiveFailures: 3 });
    expect(degraded.outboundLastErrorSummary).toMatch(/HTTP_500/);
    expect(degraded.outboundPausedAt).toBeNull();
    ok = true;
    advance(clock, 60_000);
    await pass(clock, http);
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).toMatchObject({ outboundHealthStatus: "HEALTHY", outboundConsecutiveFailures: 0, outboundLastErrorSummary: null });
  });

  it("pauses outbound delivery after 10 consecutive failures, loses nothing, and resumes on enable", async () => {
    const { ctx, clock, order, integ } = await setup();
    for (let i = 0; i < 12; i++) await order();
    let ok = false;
    const http = new FakeHttp(() => (ok ? respond(200) : respond(500)));
    await pass(clock, http, { maxItems: 50 });

    const row = await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } });
    expect(row).toMatchObject({ outboundHealthStatus: "FAILING", outboundConsecutiveFailures: 10 });
    expect(row.outboundPausedAt).not.toBeNull();
    expect(http.requests).toHaveLength(10); // the breaker stopped the last two before they were sent
    const byStatus = (await deliveries()).reduce<Record<string, number>>((m, d) => ({ ...m, [d.status]: (m[d.status] ?? 0) + 1 }), {});
    expect(byStatus).toEqual({ FAILED: 10, PENDING: 2 }); // nothing lost, nothing dead
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "PAUSED" } })).toBe(1);

    // the target recovers, time passes, but the integration stays paused until an admin resumes it
    ok = true;
    advance(clock, 3600_000);
    await pass(clock, http, { maxItems: 50 });
    expect(http.requests).toHaveLength(10);

    // new events are still queued while paused
    await order();
    await pass(clock, http, { maxItems: 50 });
    expect(await prisma.integrationDelivery.count()).toBe(13);
    expect(http.requests).toHaveLength(10);

    await enableIntegration(ctx, integ.id); // resume
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).toMatchObject({ outboundPausedAt: null, outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY" });
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "RESUMED" } })).toBe(1);
    await pass(clock, http, { maxItems: 50 });
    expect(await prisma.integrationDelivery.count({ where: { status: "SUCCEEDED" } })).toBe(13);
    expect(http.requests).toHaveLength(23); // 10 failed attempts + 13 successful ones
    expect(new Set(http.requests.slice(10).map((r) => r.headers["X-WMS-Event-Id"])).size).toBe(13);
  });

  it("a connection test sends a signed test event, records the outcome and creates no delivery or outbox event", async () => {
    const { ctx, integ, clock } = await setup();
    const http = new FakeHttp();
    const ok = await testIntegration(ctx, integ.id, depsFor(clock, http));
    expect(ok).toMatchObject({ ok: true, httpStatus: 200, code: null });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0].headers["X-WMS-Event-Type"]).toBe("integration.test");
    expect(verifySignature({ header: http.requests[0].headers["X-WMS-Signature"], rawBody: http.requests[0].body, secrets: [integ.outboundSecret], now: clock.now })).toBe("ok");
    expect(await prisma.integrationDelivery.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);

    http.handler = () => respond(500);
    const bad = await testIntegration(ctx, integ.id, depsFor(clock, http));
    expect(bad).toMatchObject({ ok: false, httpStatus: 500, code: "HTTP_500" });
    const logs = await prisma.integrationLog.findMany({ where: { integrationId: integ.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.status)).toEqual(["TEST_SUCCEEDED", "TEST_FAILED"]);
    expect((await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).outboundConsecutiveFailures).toBe(1);
  });

  it("a connection test needs an outbound-ready integration", async () => {
    const t = await tenantWithWarehouse("wt", { bays: 1, levels: 1 });
    const inboundOnly = await newIntegration(t.ctx);
    await expect(testIntegration(t.ctx, inboundOnly.id, depsFor(clockAt(), new FakeHttp()))).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("retention", () => {
  it("purges only terminal deliveries and fanned-out events past their retention, never live work", async () => {
    const { clock, order, integ } = await setup();
    for (let i = 0; i < 4; i++) await order();
    let mode: "ok" | "dead" | "retry" = "ok";
    const http = new FakeHttp(() => (mode === "ok" ? respond(200) : mode === "dead" ? respond(404) : respond(500)));
    // delivery 1 succeeds, 2 goes dead, 3 stays FAILED (retry), 4 stays PENDING (unclaimed)
    await pass(clock, http, { maxItems: 1 });
    mode = "dead";
    await pass(clock, http, { maxItems: 1 });
    mode = "retry";
    await pass(clock, http, { maxItems: 1 });
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(["DEAD", "FAILED", "PENDING", "SUCCEEDED"]);

    const day = 24 * 3600 * 1000;

    // 6 days after: nothing is old enough
    expect(await fanoutRepo.purge(new Date(clock.now.getTime() + 6 * day), RETENTION, 100)).toEqual({ deliveries: 0, events: 0 });
    // 8 days: the SUCCEEDED delivery and its event go; DEAD (30 d), FAILED and PENDING stay
    const eight = await fanoutRepo.purge(new Date(clock.now.getTime() + 8 * day), RETENTION, 100);
    expect(eight).toEqual({ deliveries: 1, events: 1 });
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(["DEAD", "FAILED", "PENDING"]);
    // 31 days: DEAD goes too, but live work (FAILED, PENDING) and the events they need never do
    const later = await fanoutRepo.purge(new Date(clock.now.getTime() + 31 * day), RETENTION, 100);
    expect(later).toEqual({ deliveries: 1, events: 1 });
    expect((await deliveries()).map((d) => d.status).sort()).toEqual(["FAILED", "PENDING"]);
    expect(await prisma.outboxEvent.count()).toBe(2);
    expect(await prisma.integration.count({ where: { id: integ.id } })).toBe(1);
  });

  it("purges fanned-out events nobody subscribed to, but never events that have not been fanned out", async () => {
    const { ctx, clock, prod } = await setup({ events: ["order.packed"] }); // subscribes to nothing that happens here
    await makeOrder(ctx, [{ productId: prod.id, quantity: 1 }]);
    const day = 24 * 3600 * 1000;
    // not fanned out yet: never purged, however old
    expect(await fanoutRepo.purge(new Date(clock.now.getTime() + 365 * day), RETENTION, 100)).toEqual({ deliveries: 0, events: 0 });
    await pass(clock, new FakeHttp());
    expect(await prisma.integrationDelivery.count()).toBe(0);
    expect(await fanoutRepo.purge(new Date(clock.now.getTime() + 6 * day), RETENTION, 100)).toEqual({ deliveries: 0, events: 0 });
    expect(await fanoutRepo.purge(new Date(clock.now.getTime() + 8 * day), RETENTION, 100)).toEqual({ deliveries: 0, events: 1 });
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("runOnce purges only when asked to", async () => {
    const { clock, order } = await setup();
    await order();
    await pass(clock, new FakeHttp());
    const future = clockAt(new Date(clock.now.getTime() + 40 * 24 * 3600 * 1000).toISOString());
    await pass(future, new FakeHttp(), { purge: false });
    expect(await prisma.outboxEvent.count()).toBe(1);
    const summary = await pass(future, new FakeHttp(), { purge: true });
    expect(summary.purged).toEqual({ deliveries: 1, events: 1 });
    expect(await prisma.outboxEvent.count()).toBe(0);
  });
});

describe("the operational log", () => {
  it("is append-only: rows cannot be updated or deleted", async () => {
    const { clock, order } = await setup();
    await order();
    await pass(clock, new FakeHttp());
    const log = await prisma.integrationLog.findFirstOrThrow();
    await expect(prisma.integrationLog.update({ where: { id: log.id }, data: { safeSummary: "tampered" } })).rejects.toBeTruthy();
    await expect(prisma.integrationLog.delete({ where: { id: log.id } })).rejects.toBeTruthy();
    await expect(prisma.integrationLog.updateMany({ data: { status: "DEAD" } })).rejects.toBeTruthy();
    await expect(prisma.integrationLog.deleteMany({})).rejects.toBeTruthy();
    expect((await prisma.integrationLog.findUniqueOrThrow({ where: { id: log.id } })).safeSummary).not.toBe("tampered");
  });

  it("the database refuses malformed log rows (unknown status, oversized summary)", async () => {
    const { ctx, integ } = await setup();
    const base = { organizationId: ctx.organizationId, integrationId: integ.id, direction: "OUTBOUND" as const, provider: "generic-webhook", correlationId: "c" };
    await expect(prisma.integrationLog.create({ data: { ...base, status: "WHATEVER", safeSummary: "x" } })).rejects.toBeTruthy();
    await expect(prisma.integrationLog.create({ data: { ...base, status: "SUCCEEDED", safeSummary: "x".repeat(301) } })).rejects.toBeTruthy();
  });
});

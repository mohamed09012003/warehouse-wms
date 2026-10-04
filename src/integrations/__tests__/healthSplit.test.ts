// Inbound and outbound health are tracked INDEPENDENTLY. Only outbound failures drive the circuit breaker.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/lib/errors";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { makeOrder, makeProduct, newTenant, tenantWithWarehouse } from "../../../tests/support/fixtures";
import { advance, clockAt, depsFor, envelope, FakeHttp, newIntegration, signedRequest, type Clock, type TestIntegration } from "../../../tests/support/integrations";
import { enableIntegration, getIntegration, ingestWebhook, runOnce, testIntegration } from "..";

// Switch that makes the catalog's upsertProduct fail on demand (everything else is the real module).
const behavior = vi.hoisted(() => ({ fail: null as null | (() => never) }));
vi.mock("@/modules/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/catalog")>();
  return {
    ...actual,
    upsertProduct: (...args: Parameters<typeof actual.upsertProduct>) => {
      if (behavior.fail) behavior.fail();
      return actual.upsertProduct(...args);
    },
  };
});

beforeEach(async () => {
  failing.requests = [];
  behavior.fail = null;
  await resetDatabase();
});

const TARGET = "https://hooks.example.test/wms";
const conflict = () => {
  throw new ConflictError("busy");
};

async function setup(opts: { maxAttempts?: number } = {}) {
  const t = await tenantWithWarehouse("hs", { bays: 2, levels: 1 });
  const prod = await makeProduct(t.ctx, "SKU-A");
  const integ = await newIntegration(t.ctx, { outbound: true, targetUrl: TARGET, events: ["order.created"], maxAttempts: opts.maxAttempts });
  const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
  const order = () => makeOrder(t.ctx, [{ productId: prod.id, quantity: 1 }]);
  return { ...t, prod, integ, clock, order };
}
const row = (id: string) => prisma.integration.findUniqueOrThrow({ where: { id } });
const pass = (clock: Clock, http: FakeHttp, maxItems = 100) => runOnce(depsFor(clock, http), { maxItems });
const upsert = async (integ: TestIntegration, n: number) => {
  const res = await ingestWebhook(integ.publicId, signedRequest(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: `e${n}`, sku: `HS-${n}-${randomUUID().slice(0, 6)}`, name: `P${n}` })));
  expect(res.status).toBe(202);
};
const failing = new FakeHttp(() => ({ status: 500, headers: {} }));
const ok = () => new FakeHttp();

describe("independent health", () => {
  it("repeated INBOUND failures never pause outbound delivery or touch outbound health", async () => {
    const { integ, clock, order } = await setup();
    for (let i = 0; i < 12; i++) await upsert(integ, i);
    behavior.fail = conflict;
    await pass(clock, ok());
    const r = await row(integ.id);
    expect(r).toMatchObject({ inboundConsecutiveFailures: 12, inboundHealthStatus: "FAILING", outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY", outboundPausedAt: null });
    expect(r.inboundLastFailureAt).not.toBeNull();
    expect(r.inboundLastErrorSummary).toMatch(/CONFLICT/);
    expect(r.outboundLastFailureAt).toBeNull();
    expect(r.outboundLastErrorSummary).toBeNull();

    // outbound keeps working while inbound is FAILING
    await order();
    const http = ok();
    await pass(advanceBy(clock, 60_000), http);
    expect(http.requests).toHaveLength(1);
    expect(await prisma.integrationDelivery.count({ where: { status: "SUCCEEDED" } })).toBe(1);
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "PAUSED" } })).toBe(0);
    expect(await row(integ.id)).toMatchObject({ outboundPausedAt: null, inboundHealthStatus: "FAILING", outboundHealthStatus: "HEALTHY" });
  });

  it("an INBOUND success does not reset OUTBOUND failures", async () => {
    const { integ, clock, order } = await setup();
    for (let i = 0; i < 4; i++) await order();
    await pass(clock, failing); // 4 outbound failures
    expect(await row(integ.id)).toMatchObject({ outboundConsecutiveFailures: 4, outboundHealthStatus: "DEGRADED" });

    await upsert(integ, 1);
    await pass(advanceBy(clock, 1_000), failing); // deliveries are in backoff (30 s), so only the inbound event is processed
    const r = await row(integ.id);
    expect(r.inboundLastSuccessAt).not.toBeNull();
    expect(r).toMatchObject({ inboundConsecutiveFailures: 0, inboundHealthStatus: "HEALTHY", outboundConsecutiveFailures: 4, outboundHealthStatus: "DEGRADED" });
    expect(r.outboundLastSuccessAt).toBeNull();
    expect(r.outboundLastErrorSummary).toMatch(/HTTP_500/);
  });

  it("an INBOUND success does not clear a tripped circuit breaker either", async () => {
    const { integ, clock, order } = await setup();
    for (let i = 0; i < 10; i++) await order();
    await pass(clock, failing);
    expect((await row(integ.id)).outboundPausedAt).not.toBeNull();
    await upsert(integ, 1);
    await pass(advanceBy(clock, 5_000), ok());
    const r = await row(integ.id);
    expect(r.inboundLastSuccessAt).not.toBeNull();
    expect(r.outboundPausedAt).not.toBeNull(); // still paused
    expect(r).toMatchObject({ outboundConsecutiveFailures: 10, outboundHealthStatus: "FAILING" });
  });

  it("repeated OUTBOUND failures pause outbound delivery at 10, and inbound keeps working and stays healthy", async () => {
    const { integ, clock, order } = await setup();
    for (let i = 0; i < 12; i++) await order();
    const http = failing;
    await pass(clock, http);
    const r = await row(integ.id);
    expect(r).toMatchObject({ outboundConsecutiveFailures: 10, outboundHealthStatus: "FAILING", inboundConsecutiveFailures: 0, inboundHealthStatus: "HEALTHY" });
    expect(r.outboundPausedAt).not.toBeNull();
    expect(r.inboundLastFailureAt).toBeNull();
    expect(http.requests).toHaveLength(10); // the breaker stopped the last two before they were sent
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "PAUSED", direction: "OUTBOUND" } })).toBe(1);

    await upsert(integ, 1);
    await pass(advanceBy(clock, 60_000), http);
    expect(await prisma.inboundEvent.count({ where: { status: "SUCCEEDED" } })).toBe(1); // inbound is not paused
    expect(http.requests).toHaveLength(10);
  });

  it("an OUTBOUND success resets only the outbound failure counter", async () => {
    const { integ, clock, order } = await setup();
    for (let i = 0; i < 3; i++) await upsert(integ, i);
    behavior.fail = conflict;
    await pass(clock, ok());
    for (let i = 0; i < 3; i++) await order();
    await pass(clock, failing);
    expect(await row(integ.id)).toMatchObject({ inboundConsecutiveFailures: 3, inboundHealthStatus: "DEGRADED", outboundConsecutiveFailures: 3, outboundHealthStatus: "DEGRADED" });

    // the target recovers; inbound keeps failing (still conflicting)
    const http = ok();
    await pass(advanceBy(clock, 31_000), http);
    const r = await row(integ.id);
    expect(http.requests).toHaveLength(3);
    expect(r.outboundLastSuccessAt).not.toBeNull();
    expect(r).toMatchObject({ outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY", outboundLastErrorSummary: null });
    // inbound was NOT reset by the outbound success (its own retries failed again)
    expect(r.inboundConsecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(r.inboundHealthStatus).not.toBe("HEALTHY");
    expect(r.inboundLastSuccessAt).toBeNull();
  });

  it("inbound and outbound health can differ, and the API reports each direction separately", async () => {
    const { ctx, integ, clock, order } = await setup();
    for (let i = 0; i < 10; i++) await upsert(integ, i);
    behavior.fail = conflict;
    await pass(clock, ok());
    const inboundBad = await getIntegration(ctx, integ.id);
    expect(inboundBad.inbound).toMatchObject({ healthStatus: "FAILING", consecutiveFailures: 10 });
    expect(inboundBad.outbound).toMatchObject({ healthStatus: "HEALTHY", consecutiveFailures: 0, lastErrorSummary: null });
    expect(inboundBad.outboundPausedAt).toBeNull();

    // now the reverse: a second integration with healthy inbound and failing outbound
    behavior.fail = null;
    const other = await newIntegration(ctx, { name: "reverse", outbound: true, targetUrl: TARGET, events: ["order.created"] });
    for (let i = 0; i < 4; i++) await order();
    await pass(advanceBy(clock, 60_000), failing);
    const outboundBad = await getIntegration(ctx, other.id);
    expect(outboundBad.inbound).toMatchObject({ healthStatus: "HEALTHY", consecutiveFailures: 0 });
    expect(outboundBad.outbound).toMatchObject({ healthStatus: "DEGRADED", consecutiveFailures: 4 });
    expect(outboundBad.outbound.lastErrorSummary).toMatch(/HTTP_500/);
  });

  it("resuming (enable) clears only the outbound side; inbound health is left as it is", async () => {
    const { ctx, integ, clock, order } = await setup();
    for (let i = 0; i < 3; i++) await upsert(integ, i);
    behavior.fail = conflict;
    await pass(clock, ok());
    behavior.fail = null;
    for (let i = 0; i < 10; i++) await order();
    await pass(advanceBy(clock, 1_000), failing);
    expect((await row(integ.id)).outboundPausedAt).not.toBeNull();

    await enableIntegration(ctx, integ.id);
    expect(await row(integ.id)).toMatchObject({ outboundPausedAt: null, outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY", inboundConsecutiveFailures: 3, inboundHealthStatus: "DEGRADED" });
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "RESUMED" } })).toBe(1);
  });

  it("a failing connection test is an outbound failure only", async () => {
    const { ctx, integ, clock } = await setup();
    await testIntegration(ctx, integ.id, depsFor(clock, failing));
    expect(await row(integ.id)).toMatchObject({ outboundConsecutiveFailures: 1, inboundConsecutiveFailures: 0 });
    await testIntegration(ctx, integ.id, depsFor(clock, ok()));
    expect(await row(integ.id)).toMatchObject({ outboundConsecutiveFailures: 0, outboundHealthStatus: "HEALTHY" });
  });

  it("lease expiries count against their own direction", async () => {
    const { integ, clock, order } = await setup({ maxAttempts: 5 });
    await upsert(integ, 1);
    await order();
    const { inboundRepo } = await import("../repo/inboundRepo");
    const { deliveryRepo } = await import("../repo/deliveryRepo");
    const { fanOutOutbox } = await import("../service/fanout");
    await fanOutOutbox(depsFor(clock, ok()));
    await inboundRepo.claim(clock.now, 1);
    await deliveryRepo.claim(clock.now, 1);
    advance(clock, 61_000);
    behavior.fail = conflict; // make the reclaimed inbound attempt fail too, but that is still inbound
    await pass(clock, failing, 0);
    const r = await row(integ.id);
    expect(r.inboundConsecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(r.outboundConsecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(r.inboundLastErrorSummary).toMatch(/LEASE_EXPIRED|CONFLICT/);
    expect(r.outboundLastErrorSummary).toMatch(/LEASE_EXPIRED/);
  });
});

describe("tenant isolation of health", () => {
  it("failures of one tenant's integration never change another tenant's health or breaker, and health is not readable across tenants", async () => {
    const a = await setup();
    const b = await newTenant("hb");
    const bInteg = await newIntegration(b.ctx, { name: "B", outbound: true, targetUrl: TARGET, events: ["order.created"] });
    for (let i = 0; i < 12; i++) await a.order();
    for (let i = 0; i < 12; i++) await upsert(a.integ, i);
    behavior.fail = conflict;
    await pass(a.clock, failing);
    expect((await row(a.integ.id)).outboundPausedAt).not.toBeNull();
    expect(await row(bInteg.id)).toMatchObject({ inboundConsecutiveFailures: 0, outboundConsecutiveFailures: 0, inboundHealthStatus: "HEALTHY", outboundHealthStatus: "HEALTHY", outboundPausedAt: null });
    const dto = await getIntegration(b.ctx, bInteg.id);
    expect(dto.inbound.consecutiveFailures + dto.outbound.consecutiveFailures).toBe(0);
    await expect(getIntegration(b.ctx, a.integ.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("database guards", () => {
  it("rejects negative failure counters in either direction and over-long summaries", async () => {
    const { integ } = await setup();
    await expect(prisma.integration.update({ where: { id: integ.id }, data: { inboundConsecutiveFailures: -1 } })).rejects.toBeTruthy();
    await expect(prisma.integration.update({ where: { id: integ.id }, data: { outboundConsecutiveFailures: -1 } })).rejects.toBeTruthy();
    await expect(prisma.integration.update({ where: { id: integ.id }, data: { outboundLastErrorSummary: "x".repeat(301) } })).rejects.toBeTruthy();
    await expect(prisma.integration.update({ where: { id: integ.id }, data: { inboundLastErrorSummary: "x".repeat(301) } })).rejects.toBeTruthy();
  });
});

function advanceBy(clock: Clock, ms: number): Clock {
  advance(clock, ms);
  return clock;
}

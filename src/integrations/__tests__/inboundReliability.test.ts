// Inbound reliability: transient failures retry with backoff and end DEAD, leases are recovered,
// concurrent workers never process an event twice, racing events for the same entity stay consistent.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "@/lib/errors";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { makeProduct, newTenant } from "../../../tests/support/fixtures";
import { advance, clockAt, depsFor, envelope, FakeHttp, newIntegration, signedRequest, type Clock, type TestIntegration } from "../../../tests/support/integrations";
import { ingestWebhook, replayInboundEvent, runOnce } from "..";
import { BACKOFF_SCHEDULE_MS } from "../core/retry";
import { inboundRepo } from "../repo/inboundRepo";

// A switch that makes the catalog's upsertProduct fail on demand (everything else is the real module).
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
  behavior.fail = null;
  await resetDatabase();
});

async function receive(integ: TestIntegration, type: string, data: Record<string, unknown>, eventId: string = randomUUID()) {
  const res = await ingestWebhook(integ.publicId, signedRequest(integ.publicId, integ.inboundSecret, envelope(type, data, eventId)));
  expect(res.status).toBe(202);
  return eventId;
}
const stored = (id: string) => prisma.inboundEvent.findFirstOrThrow({ where: { externalEventId: id } });
const pass = (clock: Clock, options?: Parameters<typeof runOnce>[1]) => runOnce(depsFor(clock, new FakeHttp()), options);
const upsertData = (n = 1) => ({ externalId: `ext-${n}`, sku: `SKU-${n}`, name: `Product ${n}` });

describe("transient failures", () => {
  it("a concurrent-change conflict is retried after 30 s and then succeeds, with no duplicate effects", async () => {
    const t = await newTenant("tr");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    const id = await receive(integ, "product.upsert", upsertData());
    behavior.fail = () => {
      throw new ConflictError("SKU was created concurrently; retry");
    };
    await pass(clock);
    const failed = await stored(id);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: "CONFLICT", processedAt: null });
    expect(failed.nextAttemptAt.getTime() - clock.now.getTime()).toBe(30_000);
    expect(await prisma.product.count()).toBe(0);

    behavior.fail = null;
    advance(clock, 29_000);
    await pass(clock);
    expect((await stored(id)).status).toBe("FAILED"); // not due yet
    advance(clock, 1_000);
    await pass(clock);
    expect(await stored(id)).toMatchObject({ status: "SUCCEEDED", attempts: 2, lastErrorCode: null });
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.externalRef.count()).toBe(1);
    const statuses = (await prisma.integrationLog.findMany({ where: { integrationId: integ.id }, orderBy: { createdAt: "asc" } })).map((l) => l.status);
    expect(statuses).toEqual(["RECEIVED", "RETRY_SCHEDULED", "SUCCEEDED"]);
  });

  it("database and unexpected errors are retried with generic summaries: no SQL, connection string, secret or message text is stored or logged", async () => {
    const leaks = ["SELECT * FROM", "postgresql://svc:TopSecretPw@db/prod", "secret-token-abc123"];
    const errors: (() => never)[] = [
      () => {
        throw Object.assign(new Error(`Timed out running SELECT * FROM "Product" via postgresql://svc:TopSecretPw@db/prod`), { code: "P2024" });
      },
      () => {
        throw new Error("boom secret-token-abc123 postgresql://svc:TopSecretPw@db/prod");
      },
    ];
    for (const [i, boom] of errors.entries()) {
      await resetDatabase();
      const t = await newTenant("tr");
      const integ = await newIntegration(t.ctx);
      const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
      const id = await receive(integ, "product.upsert", upsertData());
      behavior.fail = boom;
      await pass(clock);
      const ev = await stored(id);
      expect(ev).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: i === 0 ? "DATABASE_ERROR" : "INTERNAL_ERROR" });
      const everything = JSON.stringify([ev, await prisma.integrationLog.findMany(), await prisma.integration.findMany()]);
      for (const leak of leaks) expect(everything).not.toContain(leak);
    }
  });

  it("follows the backoff schedule, ends DEAD after the attempt limit, and an admin replay gives a fresh budget", async () => {
    const t = await newTenant("tr");
    const integ = await newIntegration(t.ctx, { maxAttempts: 4 });
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    const id = await receive(integ, "product.upsert", upsertData());
    behavior.fail = () => {
      throw new ConflictError("still conflicting");
    };
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      await pass(clock);
      const ev = await stored(id);
      expect(ev.attempts).toBe(attempt);
      if (attempt < 4) {
        expect(ev.status).toBe("FAILED");
        delays.push(ev.nextAttemptAt.getTime() - clock.now.getTime());
        advance(clock, delays.at(-1)!);
      }
    }
    expect(delays).toEqual(BACKOFF_SCHEDULE_MS.slice(0, 3).map(Number));
    expect(await stored(id)).toMatchObject({ status: "DEAD", attempts: 4 });
    expect((await stored(id)).processedAt).not.toBeNull();
    advance(clock, 24 * 3600_000);
    await pass(clock);
    expect((await stored(id)).attempts).toBe(4); // DEAD is not retried

    behavior.fail = null;
    await replayInboundEvent(t.ctx, integ.id, (await stored(id)).id);
    expect(await stored(id)).toMatchObject({ status: "RECEIVED", attempts: 0, lastErrorCode: null, processedAt: null });
    advance(clock, 10_000);
    await pass(clock);
    expect(await stored(id)).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
    expect(await prisma.product.count()).toBe(1);
  });

  it("transient failures degrade integration health; success restores it", async () => {
    const t = await newTenant("tr");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    for (let i = 1; i <= 3; i++) await receive(integ, "product.upsert", upsertData(i));
    behavior.fail = () => {
      throw new ConflictError("busy");
    };
    await pass(clock);
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).toMatchObject({ inboundHealthStatus: "DEGRADED", inboundConsecutiveFailures: 3 });
    behavior.fail = null;
    advance(clock, 60_000);
    await pass(clock);
    expect(await prisma.integration.findUniqueOrThrow({ where: { id: integ.id } })).toMatchObject({ inboundHealthStatus: "HEALTHY", inboundConsecutiveFailures: 0, inboundLastErrorSummary: null });
    expect(await prisma.inboundEvent.count({ where: { status: "SUCCEEDED" } })).toBe(3);
  });
});

describe("leases", () => {
  it("recovers an event whose worker vanished", async () => {
    const t = await newTenant("ls");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    const id = await receive(integ, "product.upsert", upsertData());
    const [claimed] = await inboundRepo.claim(clock.now, 1); // the worker dies right here
    expect(claimed.attempts).toBe(1);
    expect((await stored(id)).status).toBe("PROCESSING");

    advance(clock, 30_000);
    expect((await pass(clock)).reapedInbound).toBe(0); // lease (60 s) still valid; nobody else may take it
    expect((await stored(id)).status).toBe("PROCESSING");
    advance(clock, 31_000);
    const summary = await pass(clock);
    expect(summary.reapedInbound).toBe(1);
    expect(summary.inbound.succeeded).toBe(1);
    expect(await stored(id)).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "LEASE_EXPIRED" } })).toBe(1);
    expect(await prisma.product.count()).toBe(1);
  });

  it("goes DEAD when the lease expires on the last allowed attempt", async () => {
    const t = await newTenant("ls");
    const integ = await newIntegration(t.ctx, { maxAttempts: 1 });
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    const id = await receive(integ, "product.upsert", upsertData());
    await inboundRepo.claim(clock.now, 1);
    advance(clock, 61_000);
    await pass(clock);
    expect(await stored(id)).toMatchObject({ status: "DEAD", lastErrorCode: "LEASE_EXPIRED" });
    expect(await prisma.product.count()).toBe(0);
  });
});

describe("concurrency", () => {
  it("several workers process every event exactly once", async () => {
    const t = await newTenant("cc");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    for (let i = 1; i <= 24; i++) await receive(integ, "product.upsert", upsertData(i));
    await Promise.all(Array.from({ length: 4 }, () => pass(clock, { maxItems: 100 })));
    expect(await prisma.inboundEvent.count({ where: { status: "SUCCEEDED", attempts: 1 } })).toBe(24);
    expect(await prisma.product.count()).toBe(24);
    expect(await prisma.externalRef.count()).toBe(24);
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "SUCCEEDED" } })).toBe(24);
  });

  it("claims never overlap (FOR UPDATE SKIP LOCKED)", async () => {
    const t = await newTenant("cc");
    const integ = await newIntegration(t.ctx);
    for (let i = 1; i <= 20; i++) await receive(integ, "product.upsert", upsertData(i));
    const now = new Date(Date.now() + 1000);
    const batches = await Promise.all(Array.from({ length: 5 }, () => inboundRepo.claim(now, 8)));
    const ids = batches.flat().map((c) => c.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("many distinct events for the SAME external order create one order, and none ends DEAD", async () => {
    const t = await newTenant("cc");
    const prod = await makeProduct(t.ctx, "RACE-SKU");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    for (let i = 0; i < 8; i++) await receive(integ, "order.create", { externalId: "same-order", lines: [{ sku: prod.sku, quantity: 1 }] });
    for (let round = 0; round < 6; round++) {
      await Promise.all(Array.from({ length: 4 }, () => pass(clock, { maxItems: 50 })));
      advance(clock, 31_000); // let any conflict-retries come due
      if ((await prisma.inboundEvent.count({ where: { status: { in: ["RECEIVED", "FAILED", "PROCESSING"] } } })) === 0) break;
    }
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.externalRef.count({ where: { entityType: "ORDER" } })).toBe(1);
    expect(await prisma.inboundEvent.count({ where: { status: "SUCCEEDED" } })).toBe(8);
    expect(await prisma.outboxEvent.count({ where: { eventType: "order.created" } })).toBe(1);
  });

  it("many distinct events for the SAME external product create one product", async () => {
    const t = await newTenant("cc");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    for (let i = 0; i < 8; i++) await receive(integ, "product.upsert", { externalId: "same-product", sku: "RACE-1", name: `Name ${i}`, barcodes: ["RACE-BC"] });
    for (let round = 0; round < 6; round++) {
      await Promise.all(Array.from({ length: 4 }, () => pass(clock, { maxItems: 50 })));
      advance(clock, 31_000);
      if ((await prisma.inboundEvent.count({ where: { status: { in: ["RECEIVED", "FAILED", "PROCESSING"] } } })) === 0) break;
    }
    expect(await prisma.product.count()).toBe(1);
    expect(await prisma.productBarcode.count()).toBe(1);
    expect(await prisma.externalRef.count()).toBe(1);
    expect(await prisma.inboundEvent.count({ where: { status: "SUCCEEDED" } })).toBe(8);
  });

  it("concurrent replays of one rejected event queue it once", async () => {
    const t = await newTenant("cc");
    const integ = await newIntegration(t.ctx);
    const clock = clockAt(new Date(Date.now() + 10_000).toISOString());
    const id = await receive(integ, "product.upsert", { externalId: "bad" });
    await pass(clock);
    const ev = await stored(id);
    expect(ev.status).toBe("REJECTED");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => replayInboundEvent(t.ctx, integ.id, ev.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
    expect(await prisma.integrationLog.count({ where: { integrationId: integ.id, status: "REPLAYED" } })).toBe(1);
  });
});

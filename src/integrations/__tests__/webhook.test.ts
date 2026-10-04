// The public inbound webhook: authentication (uniform failures), payload handling, idempotency.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { newTenant } from "../../../tests/support/fixtures";
import { canary, envelope, newIntegration, signedRequest } from "../../../tests/support/integrations";
import { disableIntegration, ingestWebhook, MAX_WEBHOOK_BODY_BYTES, setIntegrationSecret, updateIntegration } from "..";
import { signatureHeaderValue } from "../adapters/generic-webhook";
import { SECRET_ROTATION_GRACE_MS } from "../secrets/secretStore";

beforeEach(resetDatabase);

async function setup() {
  const t = await newTenant("wh");
  const integ = await newIntegration(t.ctx);
  return { ...t, integ };
}

const send = (publicId: string, secret: string, body: unknown, opts?: Parameters<typeof signedRequest>[3], now?: Date) => ingestWebhook(publicId, signedRequest(publicId, secret, body, opts), now);
const productEvent = (eventId?: string) => envelope("product.upsert", { externalId: "P-1", sku: "WIDGET-1", name: "Widget" }, eventId);

describe("authentication: every failure looks the same", () => {
  it("accepts a correctly signed event, stores it as RECEIVED and does NOT process it inline", async () => {
    const { integ, ctx } = await setup();
    const res = await send(integ.publicId, integ.inboundSecret, productEvent("evt-1"));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", eventId: "evt-1" });
    const stored = await prisma.inboundEvent.findFirstOrThrow({ where: { externalEventId: "evt-1" } });
    expect(stored).toMatchObject({ status: "RECEIVED", attempts: 0, eventType: "product.upsert", organizationId: ctx.organizationId, integrationId: integ.id });
    expect(await prisma.product.count()).toBe(0); // no business effect during the request
    expect(await prisma.externalRef.count()).toBe(0);
  });

  it("answers unknown id, malformed id, disabled, archived, wrong secret, missing/garbled signature, stale and future timestamps identically with 401", async () => {
    const { integ, ctx } = await setup();
    const archived = await newIntegration(ctx, { name: "to-archive" });
    await updateIntegration(ctx, archived.id, { archived: true });
    const disabled = await newIntegration(ctx, { name: "to-disable" });
    await disableIntegration(ctx, disabled.id);
    const outboundOnly = await newIntegration(ctx, { name: "outbound-only", inbound: false, outbound: true, targetUrl: "https://example.com/e" });
    const ev = productEvent();
    const now = Math.floor(Date.now() / 1000);

    const responses = [
      await send("A".repeat(22), integ.inboundSecret, ev), // well-formed but unknown id
      await send("short", integ.inboundSecret, ev), // malformed id
      await send(disabled.publicId, disabled.inboundSecret, ev),
      await send(archived.publicId, archived.inboundSecret, ev),
      await send(outboundOnly.publicId, outboundOnly.outboundSecret, ev),
      await send(integ.publicId, "wrong-secret-wrong-secret", ev),
      await send(integ.publicId, integ.inboundSecret, ev, { signature: "garbage" }),
      await send(integ.publicId, integ.inboundSecret, ev, { timestamp: now - 600 }), // stale
      await send(integ.publicId, integ.inboundSecret, ev, { timestamp: now + 600 }), // future
      await send(integ.publicId, integ.inboundSecret, ev, { rawBody: JSON.stringify(ev) + " ", signature: signatureHeaderValue(integ.inboundSecret, now, JSON.stringify(ev)) }), // tampered
      await ingestWebhook(integ.publicId, new Request("http://localhost/x", { method: "POST", body: JSON.stringify(ev) })), // no signature header
    ];
    for (const r of responses) {
      expect(r.status).toBe(401);
      expect(r.body).toEqual(responses[0].body);
    }
    expect(JSON.stringify(responses[0].body)).not.toMatch(/secret|signature|integration|disabled|archived|stale/i);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("accepts the previous secret during the rotation grace period and the new one immediately; the old one stops working afterwards", async () => {
    const { integ, ctx } = await setup();
    const rotated = canary("rotated");
    await setIntegrationSecret(ctx, integ.id, "inbound_signing_secret", { value: rotated });

    expect((await send(integ.publicId, rotated, productEvent("new-1"))).status).toBe(202);
    expect((await send(integ.publicId, integ.inboundSecret, productEvent("old-1"))).status).toBe(202); // grace

    const later = new Date(Date.now() + SECRET_ROTATION_GRACE_MS + 120_000);
    const ts = Math.floor(later.getTime() / 1000);
    expect((await send(integ.publicId, integ.inboundSecret, productEvent("old-2"), { timestamp: ts }, later)).status).toBe(401);
    expect((await send(integ.publicId, rotated, productEvent("new-2"), { timestamp: ts }, later)).status).toBe(202);
    expect((await send(integ.publicId, "third-wrong-secret-xx", productEvent("bad"), { timestamp: ts }, later)).status).toBe(401);
  });

  it("fails closed (401) when the stored secret cannot be decrypted, and never reveals why", async () => {
    const { integ } = await setup();
    const row = await prisma.integrationSecret.findFirstOrThrow({ where: { integrationId: integ.id, name: "inbound_signing_secret" } });
    const flipped = Buffer.from(row.ciphertext);
    flipped[0] ^= 0xff;
    await prisma.integrationSecret.update({ where: { id: row.id }, data: { ciphertext: new Uint8Array(flipped) } });
    const res = await send(integ.publicId, integ.inboundSecret, productEvent());
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/decrypt|vault|key/i);
  });

  it("a secret of tenant B does not authenticate tenant A's integration and vice versa", async () => {
    const a = await newTenant("xa");
    const b = await newTenant("xb");
    const ia = await newIntegration(a.ctx);
    const ib = await newIntegration(b.ctx);
    expect((await send(ia.publicId, ib.inboundSecret, productEvent())).status).toBe(401);
    expect((await send(ib.publicId, ia.inboundSecret, productEvent())).status).toBe(401);
    // the same external event id is independent per integration
    expect((await send(ia.publicId, ia.inboundSecret, productEvent("same-id"))).status).toBe(202);
    expect((await send(ib.publicId, ib.inboundSecret, productEvent("same-id"))).status).toBe(202);
    expect(await prisma.inboundEvent.count({ where: { externalEventId: "same-id" } })).toBe(2);
    expect(await prisma.inboundEvent.count({ where: { organizationId: a.ctx.organizationId } })).toBe(1);
  });
});

describe("payload handling", () => {
  it("rejects bodies over 256 KiB with 413 before anything is stored (declared and streamed)", async () => {
    const { integ } = await setup();
    const big = JSON.stringify({ ...productEvent(), pad: "x".repeat(MAX_WEBHOOK_BODY_BYTES) });
    const declared = signedRequest(integ.publicId, integ.inboundSecret, big, { extraHeaders: { "content-length": String(big.length) } });
    expect((await ingestWebhook(integ.publicId, declared)).status).toBe(413);

    // no content-length header: the limit is enforced while streaming
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= 8) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const streamed = new Request(`http://localhost/api/webhooks/${integ.publicId}`, { method: "POST", body: stream, duplex: "half", headers: { "x-wms-signature": "t=1,v1=" + "a".repeat(64) } } as RequestInit);
    expect((await ingestWebhook(integ.publicId, streamed)).status).toBe(413);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("accepts a body just under the limit", async () => {
    const { integ } = await setup();
    const body = { ...productEvent("big-ok"), data: { externalId: "P-9", sku: "BIG", name: "n", pad: "x".repeat(100_000) } };
    expect((await send(integ.publicId, integ.inboundSecret, body)).status).toBe(202);
  });

  it("returns 400 for a validly signed but malformed body or envelope", async () => {
    const { integ } = await setup();
    const bad: unknown[] = [
      "{not json",
      "[]",
      "null",
      "42",
      {},
      { type: "product.upsert", occurredAt: new Date().toISOString(), data: {} }, // no eventId
      { eventId: "e1", occurredAt: new Date().toISOString(), data: {} }, // no type
      { eventId: "e1", type: "NOT A TYPE", occurredAt: new Date().toISOString(), data: {} },
      { eventId: "e1", type: "product", occurredAt: new Date().toISOString(), data: {} },
      { eventId: "bad id with spaces", type: "product.upsert", occurredAt: new Date().toISOString(), data: {} },
      { eventId: "e".repeat(129), type: "product.upsert", occurredAt: new Date().toISOString(), data: {} },
      { eventId: "e1", type: "product.upsert", occurredAt: "yesterday", data: {} },
      { eventId: "e1", type: "product.upsert", occurredAt: new Date().toISOString(), data: "text" },
      { eventId: "e1", type: "product.upsert", occurredAt: new Date().toISOString(), data: [1, 2] },
      { eventId: "e1", type: "product.upsert", occurredAt: new Date().toISOString() },
    ];
    for (const b of bad) {
      const res = await send(integ.publicId, integ.inboundSecret, typeof b === "string" ? b : b);
      expect(res.status, JSON.stringify(b)).toBe(400);
      expect((res.body.error as { code: string }).code).toBe("VALIDATION_FAILED");
    }
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("treats a body that is not valid UTF-8 as unauthenticated rather than crashing", async () => {
    const { integ } = await setup();
    const req = new Request(`http://localhost/api/webhooks/${integ.publicId}`, { method: "POST", body: new Uint8Array([0xff, 0xfe, 0xfd, 0x7b, 0x7d]), headers: { "x-wms-signature": "t=1,v1=" + "a".repeat(64) } });
    expect((await ingestWebhook(integ.publicId, req)).status).toBe(401);
  });

  it("once the envelope is valid, semantic problems are accepted (202) and become REJECTED events later, so senders never retry forever", async () => {
    const { integ } = await setup();
    const semantic = [
      envelope("product.upsert", { externalId: "P", name: "no sku" }, "sem-1"),
      envelope("order.create", { externalId: "O", lines: [] }, "sem-2"),
      envelope("totally.unknown", { anything: true }, "sem-3"),
    ];
    for (const e of semantic) expect((await send(integ.publicId, integ.inboundSecret, e)).status).toBe(202);
    expect(await prisma.inboundEvent.count({ where: { status: "RECEIVED" } })).toBe(3);
  });

  it("stores the validated envelope and a SHA-256 of the raw body", async () => {
    const { integ } = await setup();
    const ev = productEvent("hash-1");
    const raw = JSON.stringify(ev);
    await send(integ.publicId, integ.inboundSecret, ev, { rawBody: raw });
    const stored = await prisma.inboundEvent.findFirstOrThrow({ where: { externalEventId: "hash-1" } });
    expect(stored.payloadHash).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(stored.payload).toMatchObject({ eventId: "hash-1", type: "product.upsert", data: { sku: "WIDGET-1" } });
  });

  it("uses a safe X-Request-Id as the correlation id, otherwise generates one", async () => {
    const { integ } = await setup();
    await send(integ.publicId, integ.inboundSecret, productEvent("corr-1"), { extraHeaders: { "x-request-id": "req-abc-12345" } });
    await send(integ.publicId, integ.inboundSecret, productEvent("corr-2"), { extraHeaders: { "x-request-id": "bad id\twith junk" } });
    const [one, two] = await Promise.all(["corr-1", "corr-2"].map((id) => prisma.inboundEvent.findFirstOrThrow({ where: { externalEventId: id } })));
    expect(one.correlationId).toBe("req-abc-12345");
    expect(two.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("idempotency", () => {
  it("the same event delivered twice is accepted once and answered as a duplicate afterwards", async () => {
    const { integ } = await setup();
    const ev = productEvent("dup-1");
    const raw = JSON.stringify(ev);
    expect((await send(integ.publicId, integ.inboundSecret, ev, { rawBody: raw })).status).toBe(202);
    const again = await send(integ.publicId, integ.inboundSecret, ev, { rawBody: raw });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: "duplicate", eventId: "dup-1" });
    // a retry with a fresh timestamp/signature but the same body is still a duplicate
    expect((await send(integ.publicId, integ.inboundSecret, ev, { rawBody: raw, timestamp: Math.floor(Date.now() / 1000) - 30 })).status).toBe(200);
    expect(await prisma.inboundEvent.count({ where: { externalEventId: "dup-1" } })).toBe(1);
  });

  it("the same event id with a different payload is a 409 conflict and changes nothing", async () => {
    const { integ } = await setup();
    await send(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "A", name: "first" }, "conflict-1"));
    const res = await send(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "A", name: "second" }, "conflict-1"));
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("CONFLICT");
    const stored = await prisma.inboundEvent.findMany({ where: { externalEventId: "conflict-1" } });
    expect(stored).toHaveLength(1);
    expect((stored[0].payload as { data: { name: string } }).data.name).toBe("first");
  });

  it("many identical deliveries racing each other store exactly one event", async () => {
    const { integ } = await setup();
    const ev = productEvent("race-1");
    const raw = JSON.stringify(ev);
    const results = await Promise.all(Array.from({ length: 12 }, () => send(integ.publicId, integ.inboundSecret, ev, { rawBody: raw })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(11);
    expect(await prisma.inboundEvent.count({ where: { externalEventId: "race-1" } })).toBe(1);
  });

  it("racing deliveries of the same id with DIFFERENT payloads: one wins, the rest are 409", async () => {
    const { integ } = await setup();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => send(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "A", name: `variant ${i}` }, "race-2"))),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await prisma.inboundEvent.count({ where: { externalEventId: "race-2" } })).toBe(1);
  });
});

describe("webhook log and responses", () => {
  it("records RECEIVED / DUPLICATE / CONFLICT in the append-only log without any payload content", async () => {
    const { integ } = await setup();
    const marker = canary("payload-marker");
    const ev = envelope("product.upsert", { externalId: "P", sku: "A", name: marker }, "log-1");
    await send(integ.publicId, integ.inboundSecret, ev);
    await send(integ.publicId, integ.inboundSecret, ev, { rawBody: JSON.stringify(ev) });
    await send(integ.publicId, integ.inboundSecret, envelope("product.upsert", { externalId: "P", sku: "A", name: "other" }, "log-1"));
    const logs = await prisma.integrationLog.findMany({ where: { integrationId: integ.id }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.status)).toEqual(["RECEIVED", "DUPLICATE", "CONFLICT"]);
    expect(logs.every((l) => l.direction === "INBOUND" && l.eventId === "log-1" && l.provider === "generic-webhook")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(marker);
    expect(JSON.stringify(logs)).not.toContain(integ.inboundSecret);
  });

  it("no response body ever contains a secret", async () => {
    const { integ } = await setup();
    const all = [
      await send(integ.publicId, integ.inboundSecret, productEvent("r1")),
      await send(integ.publicId, integ.inboundSecret, productEvent("r1")),
      await send(integ.publicId, "wrong-wrong-wrong-wrong", productEvent("r2")),
      await send(integ.publicId, integ.inboundSecret, "{bad"),
    ];
    expect(JSON.stringify(all)).not.toContain(integ.inboundSecret);
  });
});

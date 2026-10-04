// The fake ERP (development tool, tools/fake-erp) must speak the EXACT Phase 6 contract. These tests wire it to the
// real WMS integration layer in both directions. The fake ERP itself imports nothing from the WMS.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signatureHeaderValue, verifySignature as wmsVerify } from "@/integrations/adapters/generic-webhook";
import { ingestWebhook, runOnce } from "@/integrations";
import { defaultWorkerDeps } from "@/integrations/service/workerDeps";
import { createFakeErp } from "../tools/fake-erp/app";
import { redact, signBody, verifySignature as erpVerify } from "../tools/fake-erp/lib";
import { prisma, resetDatabase } from "./support/db";
import { makeOrder, makeProduct, newTenant } from "./support/fixtures";
import { canary, newIntegration } from "./support/integrations";

beforeEach(resetDatabase);

const open: ReturnType<typeof createFakeErp>[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => (e.server.listening ? e.close() : Promise.resolve())));
});

async function listen(env: Record<string, string>, fetchImpl?: typeof fetch) {
  const erp = createFakeErp({ dataFile: null, env, fetchImpl });
  await new Promise<void>((resolve) => erp.server.listen(0, "127.0.0.1", resolve));
  open.push(erp);
  const port = (erp.server.address() as { port: number }).port;
  return { erp, base: `http://127.0.0.1:${port}` };
}

/** A fetch that delivers straight into the REAL WMS webhook service (what the Next.js route does). */
const wmsFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  const res = await ingestWebhook(new URL(url).pathname.split("/").pop()!, new Request(url, init));
  return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
};

const form = (data: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data), redirect: "manual" as const });

describe("signature contract (independent implementations agree)", () => {
  const secret = canary("sig");
  const body = JSON.stringify({ eventId: "e1", type: "order.created", data: { n: 1 } });

  it("what the ERP signs, the WMS verifies; what the WMS signs, the ERP verifies", () => {
    const t = Math.floor(Date.now() / 1000);
    expect(wmsVerify({ header: signBody(secret, body, t), rawBody: body, secrets: [secret], now: new Date() })).toBe("ok");
    expect(erpVerify(secret, signatureHeaderValue(secret, t, body), body)).toBe("VALID");
    expect(signBody(secret, body, t)).toBe(signatureHeaderValue(secret, t, body)); // byte-identical headers
  });

  it("both reject tampering, wrong secrets and stale timestamps the same way", () => {
    const t = Math.floor(Date.now() / 1000);
    const header = signBody(secret, body, t);
    expect(erpVerify(secret, header, body + " ")).toBe("INVALID_SIGNATURE");
    expect(erpVerify("other-secret-value-xx", header, body)).toBe("INVALID_SIGNATURE");
    expect(erpVerify(secret, signBody(secret, body, t - 400), body)).toBe("STALE_TIMESTAMP");
    expect(erpVerify(secret, null, body)).toBe("MISSING_SIGNATURE");
    expect(erpVerify(null, header, body)).toBe("NO_SECRET_CONFIGURED");
    expect(wmsVerify({ header: signBody(secret, body, t - 400), rawBody: body, secrets: [secret], now: new Date() })).toBe("stale");
  });
});

describe("fake ERP -> WMS (the real inbound webhook service)", () => {
  async function setup() {
    const t = await newTenant("fe");
    const integ = await newIntegration(t.ctx);
    const { erp, base } = await listen({ WMS_WEBHOOK_BASE_URL: "http://wms.test", WMS_INTEGRATION_PUBLIC_ID: integ.publicId, WMS_INBOUND_SECRET: integ.inboundSecret }, wmsFetch);
    return { ...t, integ, erp, base };
  }

  it("sends the seeded products and orders; the WMS accepts them (202) and the worker turns them into WMS products and orders", async () => {
    const { erp, ctx } = await setup();
    expect(erp.store.state.products.map((p) => p.sku)).toEqual(["DEMO-001", "DEMO-002", "DEMO-003"]);
    expect(erp.store.state.orders.map((o) => o.id)).toEqual(["ERP-ORDER-001", "ERP-ORDER-002"]);
    for (const m of [...erp.store.state.messages]) {
      const attempt = await erp.sendMessage(m);
      expect(attempt.httpStatus, `${m.type}`).toBe(202);
      expect(m.status).toBe("SENT");
    }
    expect(await prisma.inboundEvent.count({ where: { status: "RECEIVED" } })).toBe(5);

    const summary = await runOnce(defaultWorkerDeps());
    expect(summary.inbound).toMatchObject({ succeeded: 5, rejected: 0, failed: 0, dead: 0 });
    expect((await prisma.product.findMany({ orderBy: { sku: "asc" } })).map((p) => p.name)).toEqual(["Blue Widget", "Red Widget", "Green Widget"]);
    const orders = await prisma.order.findMany({ where: { organizationId: ctx.organizationId }, include: { lines: { include: { product: true } } }, orderBy: { orderNumber: "asc" } });
    expect(orders.map((o) => [o.orderNumber, o.status, o.externalRef])).toEqual([["ERP-ORDER-001", "READY", "ERP-ORDER-001"], ["ERP-ORDER-002", "READY", "ERP-ORDER-002"]]);
    expect(orders[0].lines.map((l) => [l.product.sku, l.requestedQty]).sort()).toEqual([["DEMO-001", 5], ["DEMO-002", 2]]);
  });

  it("cancelling in the ERP and sending order.cancel cancels the WMS order", async () => {
    const { erp, base } = await setup();
    for (const m of [...erp.store.state.messages]) await erp.sendMessage(m);
    await runOnce(defaultWorkerDeps());
    const r = await fetch(`${base}/orders/ERP-ORDER-001/cancel`, form({}));
    expect(r.status).toBe(303);
    expect(erp.store.state.orders[0].status).toBe("CANCELLED");
    const cancel = erp.store.state.messages.find((m) => m.type === "order.cancel")!;
    expect((await erp.sendMessage(cancel)).httpStatus).toBe(202);
    await runOnce(defaultWorkerDeps());
    expect((await prisma.order.findFirstOrThrow({ where: { orderNumber: "ERP-ORDER-001" } })).status).toBe("CANCELLED");
  });

  it("re-sending the same message is byte-identical, so the WMS answers 'duplicate' (idempotency)", async () => {
    const { erp } = await setup();
    const m = erp.store.state.messages[0];
    expect((await erp.sendMessage(m)).httpStatus).toBe(202);
    const again = await erp.sendMessage(m);
    expect(again.httpStatus).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({ status: "duplicate", eventId: m.id });
    expect(await prisma.inboundEvent.count()).toBe(1);
  });

  it("an unconfigured ERP sends nothing; a wrong secret gets the WMS's uniform 401; neither leaks a secret", async () => {
    const t = await newTenant("fe2");
    const integ = await newIntegration(t.ctx);
    const unconfigured = await listen({}, async () => {
      throw new Error("must not be called");
    });
    const first = unconfigured.erp.store.state.messages[0];
    const a = await unconfigured.erp.sendMessage(first);
    expect(a.httpStatus).toBeNull();
    expect(a.error).toMatch(/Not configured/);

    const wrongSecret = canary("wrong");
    const wrong = await listen({ WMS_INTEGRATION_PUBLIC_ID: integ.publicId, WMS_INBOUND_SECRET: wrongSecret }, wmsFetch);
    const b = await wrong.erp.sendMessage(wrong.erp.store.state.messages[0]);
    expect(b.httpStatus).toBe(401);
    expect(wrong.erp.store.state.messages[0].status).toBe("FAILED");
    expect(JSON.stringify(wrong.erp.store.state)).not.toContain(wrongSecret);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("reports an unreachable WMS without exposing the URL or credentials", async () => {
    const secret = canary("net");
    const { erp } = await listen({ WMS_WEBHOOK_BASE_URL: "http://127.0.0.1:1", WMS_INTEGRATION_PUBLIC_ID: "SomePublicIdSomePublicId", WMS_INBOUND_SECRET: secret });
    const a = await erp.sendMessage(erp.store.state.messages[0]);
    expect(a.httpStatus).toBeNull();
    expect(a.error).toMatch(/Could not reach the WMS/);
    expect(JSON.stringify(a)).not.toContain(secret);
    expect(JSON.stringify(a)).not.toContain("SomePublicId");
  });
});

describe("WMS -> fake ERP (real outbound deliveries over HTTP)", () => {
  async function setup(mode?: Record<string, unknown>) {
    const t = await newTenant("fo");
    const prod = await makeProduct(t.ctx, "DEMO-001");
    const outboundSecret = canary("out");
    const { erp, base } = await listen({});
    Object.assign(erp.store.state.settings, mode);
    const integ = await newIntegration(t.ctx, { inbound: false, outbound: true, targetUrl: `${base}/wms/events`, events: ["order.created", "order.cancelled"] });
    // the ERP verifies with the secret the WMS signs with
    erp.store.state.settings.outboundSecret = integ.outboundSecret;
    const order = () => makeOrder(t.ctx, [{ productId: prod.id, quantity: 2 }]);
    return { ...t, prod, integ, erp, base, order, wrongSecret: outboundSecret };
  }
  const lastDelivery = () => prisma.integrationDelivery.findFirstOrThrow({ orderBy: { createdAt: "desc" } });

  it("receives order.created with a VALID signature, logs it with the payload, and answers 200", async () => {
    const { erp, base, order, integ } = await setup();
    const o = await order();
    const summary = await runOnce(defaultWorkerDeps());
    expect(summary.deliveries.succeeded).toBe(1);
    const [e] = erp.store.state.inbox;
    expect(e).toMatchObject({ type: "order.created", verification: "VALID", respondedWith: 200, mode: "200", duplicate: false });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.deliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.attempt).toBe("1");
    expect(e.payload).toMatchObject({ type: "order.created", data: { orderNumber: o.orderNumber } });
    expect(JSON.stringify([erp.store.state.inbox, erp.store.state.messages])).not.toContain(integ.outboundSecret); // never logged or shown
    expect(await (await fetch(`${base}/inbox`)).text()).not.toContain(integ.outboundSecret);
    expect((await lastDelivery()).status).toBe("SUCCEEDED");
  });

  it("answers with the configured status: 400 -> the WMS marks it DEAD, 500 -> retry, 429 -> retry after Retry-After, delay -> success", async () => {
    const { erp, order } = await setup();
    const run = async (settings: Record<string, unknown>) => {
      Object.assign(erp.store.state.settings, settings);
      await order();
      await runOnce(defaultWorkerDeps());
      return lastDelivery();
    };
    expect(await run({ responseMode: "400" })).toMatchObject({ status: "DEAD", lastHttpStatus: 400, lastErrorCode: "HTTP_400" });
    const failed = await run({ responseMode: "500" });
    expect(failed).toMatchObject({ status: "FAILED", lastHttpStatus: 500, lastErrorCode: "HTTP_500" });
    const limited = await run({ responseMode: "429", retryAfterSeconds: 7 });
    expect(limited).toMatchObject({ status: "FAILED", lastHttpStatus: 429 });
    const wait = limited.nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(4000);
    expect(wait).toBeLessThan(8500); // Retry-After 7 s honoured, not the 30 s default backoff
    expect(await run({ responseMode: "delay", delayMs: 250 })).toMatchObject({ status: "SUCCEEDED", lastHttpStatus: 200 });
    expect(erp.store.state.inbox.map((i) => [i.respondedWith, i.mode])).toEqual([[400, "400"], [500, "500"], [429, "429"], [200, "delay"]]);
  });

  it("a wrong shared secret is detected: the ERP flags INVALID_SIGNATURE and answers 401 (the WMS marks it DEAD)", async () => {
    const { erp, order, wrongSecret } = await setup();
    erp.store.state.settings.outboundSecret = wrongSecret;
    await order();
    await runOnce(defaultWorkerDeps());
    expect(erp.store.state.inbox[0]).toMatchObject({ verification: "INVALID_SIGNATURE", respondedWith: 401 });
    expect(await lastDelivery()).toMatchObject({ status: "DEAD", lastHttpStatus: 401 });
  });

  it("flags repeated deliveries of the same event id as duplicates (at-least-once)", async () => {
    const { erp, order } = await setup({ responseMode: "500" });
    await order();
    await runOnce(defaultWorkerDeps());
    const d = await lastDelivery();
    erp.store.state.settings.responseMode = "200";
    await prisma.integrationDelivery.update({ where: { id: d.id }, data: { nextAttemptAt: new Date(0) } });
    await runOnce(defaultWorkerDeps());
    expect(erp.store.state.inbox).toHaveLength(2);
    expect(erp.store.state.inbox[0].id).toBe(erp.store.state.inbox[1].id);
    expect(erp.store.state.inbox.map((i) => i.duplicate)).toEqual([false, true]);
    expect(erp.store.state.inbox.map((i) => i.attempt)).toEqual(["1", "2"]);
  });

  it("without a configured secret events are accepted but flagged NO_SECRET_CONFIGURED", async () => {
    const { erp, order } = await setup();
    delete erp.store.state.settings.outboundSecret;
    await order();
    await runOnce(defaultWorkerDeps());
    expect(erp.store.state.inbox[0]).toMatchObject({ verification: "NO_SECRET_CONFIGURED", respondedWith: 200 });
  });
});

describe("the fake ERP's own web UI and store", () => {
  it("renders every page with the FAKE ERP banner, escapes untrusted text, and never shows a secret", async () => {
    const secret = canary("ui");
    const { base, erp } = await listen({ WMS_INBOUND_SECRET: secret, WMS_OUTBOUND_SECRET: secret, WMS_INTEGRATION_PUBLIC_ID: "PublicIdPublicIdPublicId" });
    expect((await fetch(`${base}/products`, form({ sku: "XSS-1", name: "<script>alert(1)</script>" }))).status).toBe(303);
    for (const p of ["/", "/products", "/orders", "/outbox", "/inbox", "/settings"]) {
      const res = await fetch(`${base}${p}`);
      const html = await res.text();
      expect(res.status, p).toBe(200);
      expect(html, p).toContain("FAKE ERP");
      expect(html, p).not.toContain(secret);
      expect(html, p).not.toContain("<script>alert(1)</script>");
    }
    expect(await (await fetch(`${base}/products`)).text()).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(erp.store.state.products.map((p) => p.sku)).toContain("XSS-1");
  });

  it("saves connection settings without ever echoing a secret value", async () => {
    const { base, erp } = await listen({});
    const secret = canary("saved");
    await fetch(`${base}/settings`, form({ wmsBaseUrl: "http://localhost:3000/", publicId: "AbCdEfGhIjKlMnOpQrStUv", inboundSecret: secret, outboundSecret: secret + "2" }));
    expect(erp.effective()).toMatchObject({ wmsBaseUrl: "http://localhost:3000", publicId: "AbCdEfGhIjKlMnOpQrStUv", inboundSecret: secret });
    const html = await (await fetch(`${base}/settings`)).text();
    expect(html).not.toContain(secret);
    expect(html).toContain("set (hidden)");
    await fetch(`${base}/settings`, form({ clearInbound: "on" }));
    expect(erp.effective().inboundSecret).toBe("");
  });

  it("refuses cross-site form posts but accepts same-origin ones", async () => {
    const { base, erp } = await listen({});
    const evil = await fetch(`${base}/reset`, { ...form({}), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    erp.store.state.products.pop();
    const ok = await fetch(`${base}/reset`, { ...form({}), headers: { "content-type": "application/x-www-form-urlencoded", origin: base } });
    expect(ok.status).toBe(303);
    expect(erp.store.state.products).toHaveLength(3);
  });

  it("validates input: bad SKUs, unknown products in order lines, duplicates", async () => {
    const { base, erp } = await listen({});
    const msg = async (path: string, data: Record<string, string>) => decodeURIComponent((await fetch(`${base}${path}`, form(data))).headers.get("location") ?? "");
    expect(await msg("/products", { sku: "bad sku!", name: "x" })).toMatch(/Invalid SKU/);
    expect(await msg("/products", { sku: "DEMO-001", name: "dup" })).toMatch(/already exists/);
    expect(await msg("/orders", { id: "ERP-ORDER-001", lines: "DEMO-001:1" })).toMatch(/already exists/);
    expect(await msg("/orders", { id: "NEW-1", lines: "NOPE:1" })).toMatch(/Bad line/);
    expect(await msg("/orders", { id: "NEW-1", lines: "DEMO-001:0" })).toMatch(/Bad line/);
    expect(await msg("/orders", { id: "NEW-1", lines: "DEMO-001:1, DEMO-001:2" })).toMatch(/Bad line/);
    expect(await msg("/orders", { id: "NEW-1", lines: "DEMO-001:3, DEMO-002:1" })).toMatch(/created/);
    expect(erp.store.state.orders.at(-1)).toMatchObject({ id: "NEW-1", lines: [{ sku: "DEMO-001", quantity: 3 }, { sku: "DEMO-002", quantity: 1 }] });
  });

  it("reset restores the deterministic demo data and keeps the connection settings", async () => {
    const { base, erp } = await listen({});
    erp.store.state.settings.publicId = "KeepMeKeepMeKeepMeKeep";
    await fetch(`${base}/orders`, form({ id: "TEMP-1", lines: "DEMO-001:1" }));
    erp.store.state.inbox.push({ id: "x", type: "t", deliveryId: "d", attempt: "1", receivedAt: new Date().toISOString(), verification: "VALID", respondedWith: 200, mode: "200", duplicate: false, payload: {} });
    await fetch(`${base}/reset`, form({}));
    expect(erp.store.state.orders.map((o) => o.id)).toEqual(["ERP-ORDER-001", "ERP-ORDER-002"]);
    expect(erp.store.state.inbox).toHaveLength(0);
    expect(erp.store.state.messages).toHaveLength(5);
    expect(erp.store.state.settings.publicId).toBe("KeepMeKeepMeKeepMeKeep");
  });

  it("persists to its own JSON file (not the WMS database) and reloads it", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-erp-")), "erp.json");
    const first = createFakeErp({ dataFile: file, env: {} });
    first.store.state.orders[0].status = "CANCELLED";
    first.store.save();
    const second = createFakeErp({ dataFile: file, env: {} });
    expect(second.store.state.orders[0].status).toBe("CANCELLED");
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it("redacts secret-looking keys and long tokens in anything it displays", () => {
    const out = JSON.stringify(redact({ apiKey: "k", nested: { password: "p", ok: "fine" }, text: "Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD", id: "123e4567-e89b-12d3-a456-426614174000" }));
    expect(out).not.toMatch(/"k"|"p"|abcdefghijkl/);
    expect(out).toContain("fine");
    expect(out).toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("the fake ERP code imports nothing from the WMS (it is an external system)", () => {
    const dir = path.resolve("tools/fake-erp");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'](@\/|\.\.\/\.\.\/src|\.\.\/src)/);
    }
  });
});

// FAKE ERP (development tool): the HTTP application. It behaves like an EXTERNAL system:
//   - sends signed webhooks to the WMS  (POST {WMS}/api/webhooks/{publicId}: the Phase 6 inbound contract)
//   - receives the WMS's signed outbound webhooks at POST /wms/events and verifies their signature
// It shares nothing with the WMS (own data file, own process, no WMS imports).
import http from "node:http";
import { redact, SIGNATURE_HEADER, signBody, verifySignature } from "./lib";
import {
  orderCancelMessage,
  orderCreateMessage,
  productMessage,
  Store,
  type InboxEvent,
  type Message,
  type ResponseMode,
  type SendAttempt,
  type Settings,
} from "./store";
import { dashboardView, inboxView, ordersView, outboxView, page, productsView, settingsView, type EffectiveSettings } from "./views";

export interface FakeErpOptions {
  /** JSON data file, or null to keep everything in memory (tests). */
  dataFile: string | null;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

const MODES: ResponseMode[] = ["200", "400", "429", "500", "delay"];
const SKU = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;
const ORDER_ID = /^[A-Z0-9][A-Z0-9._/-]{0,39}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createFakeErp(options: FakeErpOptions) {
  const store = new Store(options.dataFile);
  const doFetch = options.fetchImpl ?? fetch;

  function effective(): EffectiveSettings {
    const saved = store.state.settings;
    const env = options.env;
    const pick = (key: "wmsBaseUrl" | "publicId" | "inboundSecret" | "outboundSecret", envKey: string, fallback = ""): [string, "saved" | "env" | "default"] =>
      saved[key] ? [saved[key]!, "saved"] : env[envKey] ? [env[envKey]!, "env"] : [fallback, "default"];
    const [wmsBaseUrl, a] = pick("wmsBaseUrl", "WMS_WEBHOOK_BASE_URL", "http://localhost:3000");
    const [publicId, b] = pick("publicId", "WMS_INTEGRATION_PUBLIC_ID");
    const [inboundSecret, c] = pick("inboundSecret", "WMS_INBOUND_SECRET");
    const [outboundSecret, d] = pick("outboundSecret", "WMS_OUTBOUND_SECRET");
    return {
      wmsBaseUrl: wmsBaseUrl.replace(/\/+$/, ""),
      publicId,
      inboundSecret,
      outboundSecret,
      responseMode: saved.responseMode ?? "200",
      delayMs: saved.delayMs ?? (Number(env.FAKE_ERP_DELAY_MS) || 12000),
      retryAfterSeconds: saved.retryAfterSeconds ?? 5,
      source: { wmsBaseUrl: a, publicId: b, inboundSecret: c, outboundSecret: d },
    };
  }

  /** Send one message to the WMS exactly as the Phase 6 contract defines it, and record the answer. */
  async function sendMessage(message: Message): Promise<SendAttempt> {
    const s = effective();
    const started = Date.now();
    const record = (attempt: Omit<SendAttempt, "at" | "durationMs">): SendAttempt => {
      const full = { at: new Date().toISOString(), durationMs: Date.now() - started, ...attempt };
      message.attempts.push(full);
      message.status = full.httpStatus !== null && full.httpStatus >= 200 && full.httpStatus < 300 ? "SENT" : "FAILED";
      store.save();
      return full;
    };
    if (!s.publicId || !s.inboundSecret) {
      return record({ httpStatus: null, error: "Not configured: set the WMS integration public id and the inbound signing secret in Settings. Nothing was sent.", body: "" });
    }
    // The body is built from the stored message, so a re-send is byte-identical (the WMS answers "duplicate").
    const body = JSON.stringify({ eventId: message.id, type: message.type, occurredAt: message.occurredAt, data: message.data });
    try {
      const res = await doFetch(`${s.wmsBaseUrl}/api/webhooks/${encodeURIComponent(s.publicId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signBody(s.inboundSecret, body) },
        body,
        signal: AbortSignal.timeout(20000),
      });
      const text = (await res.text()).slice(0, 2000);
      return record({ httpStatus: res.status, error: null, body: text });
    } catch (error) {
      // Never include the URL or headers: they could carry the public id.
      return record({ httpStatus: null, error: `Could not reach the WMS (${error instanceof Error ? error.name : "error"}). Is it running at ${s.wmsBaseUrl}?`, body: "" });
    }
  }

  const describe = (a: SendAttempt) => (a.httpStatus !== null ? `The WMS answered HTTP ${a.httpStatus}: ${a.body || "(no body)"}` : (a.error ?? "No response"));

  // ----------------------------------------------------------------------------------------------- WMS -> ERP
  async function receiveFromWms(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const s = effective();
    const verification = verifySignature(s.outboundSecret || null, (req.headers[SIGNATURE_HEADER] as string | undefined) ?? null, raw);
    let parsed: { eventId?: string; type?: string; data?: unknown } & Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* shown as an unparseable event */
    }
    const eventId = String(req.headers["x-wms-event-id"] ?? parsed.eventId ?? "(unknown)");
    // A wrong signature is always rejected; with no secret configured the event is accepted but flagged.
    const rejected = verification === "INVALID_SIGNATURE" || verification === "STALE_TIMESTAMP" || verification === "MISSING_SIGNATURE";
    const status = rejected ? 401 : s.responseMode === "delay" ? 200 : Number(s.responseMode);
    const event: InboxEvent = {
      id: eventId,
      type: String(req.headers["x-wms-event-type"] ?? parsed.type ?? "(unknown)"),
      deliveryId: String(req.headers["x-wms-delivery-id"] ?? "-"),
      attempt: String(req.headers["x-wms-attempt"] ?? "-"),
      receivedAt: new Date().toISOString(),
      verification,
      respondedWith: status,
      mode: rejected ? "signature check" : s.responseMode,
      duplicate: store.state.inbox.some((e) => e.id === eventId && eventId !== "(unknown)"),
      payload: redact(parsed.data !== undefined ? parsed : { unparseableBody: raw.slice(0, 500) }),
    };
    store.state.inbox.push(event);
    if (store.state.inbox.length > 500) store.state.inbox.splice(0, store.state.inbox.length - 500);
    store.save();
    if (s.responseMode === "delay" && !rejected) await sleep(s.delayMs);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (status === 429 && !rejected) headers["retry-after"] = String(s.retryAfterSeconds);
    res.writeHead(status, headers).end(JSON.stringify(status === 200 ? { received: true } : { error: rejected ? "invalid signature" : "intentional fake ERP response", mode: s.responseMode }));
  }

  // ----------------------------------------------------------------------------------------------- UI
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const send = (status: number, body: string, type = "text/html; charset=utf-8") => res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    const back = (to: string, msg?: string) => res.writeHead(303, { location: msg ? `${to}?msg=${encodeURIComponent(msg.slice(0, 1500))}` : to }).end();
    const flash = url.searchParams.get("msg");

    if (method === "POST" && url.pathname === "/wms/events") return receiveFromWms(req, res);
    if (method === "GET" && url.pathname === "/health") return send(200, JSON.stringify({ ok: true, fakeErp: true }), "application/json");

    if (method === "POST") {
      // CSRF defence for a localhost tool: browsers always send Origin on cross-site POSTs.
      const origin = req.headers.origin;
      if (origin && origin !== "null" && new URL(origin).host !== req.headers.host) return send(403, "Cross-site request blocked");
      if (origin === "null") return send(403, "Cross-site request blocked");
    }

    const state = store.state;
    try {
      if (method === "GET") {
        const s = effective();
        switch (url.pathname) {
          case "/":
            return send(200, page("Dashboard", "/", dashboardView(state, s), flash));
          case "/products":
            return send(200, page("Products (ERP master data)", "/products", productsView(state), flash));
          case "/orders":
            return send(200, page("Orders", "/orders", ordersView(state), flash));
          case "/outbox":
            return send(200, page("Outbox: messages to the WMS", "/outbox", outboxView(state), flash));
          case "/inbox":
            return send(200, page("Inbox: events received from the WMS", "/inbox", inboxView(state), flash));
          case "/settings":
            return send(200, page("Settings", "/settings", settingsView(s), flash));
          default:
            return send(404, page("Not found", "", "<p>No such page.</p>"));
        }
      }
      if (method !== "POST") return send(405, "Method not allowed");

      const form = new URLSearchParams(await readBody(req));
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (url.pathname === "/reset") {
        store.reset();
        return back("/", "Demo data was reset (products, orders, queued messages, received events). Connection settings were kept.");
      }
      if (url.pathname === "/products") {
        const sku = (form.get("sku") ?? "").trim().toUpperCase();
        const name = (form.get("name") ?? "").trim();
        if (!SKU.test(sku) || !name) return back("/products", "Invalid SKU or name (SKU: letters, digits and . _ / - only).");
        if (state.products.some((p) => p.sku === sku)) return back("/products", `Product ${sku} already exists.`);
        const barcode = (form.get("barcode") ?? "").trim();
        const product = { sku, name: name.slice(0, 200), description: "Created manually in the fake ERP", barcodes: barcode ? [barcode.slice(0, 128)] : [] };
        state.products.push(product);
        state.messages.push(productMessage(product));
        store.save();
        return back("/products", `Product ${sku} created and a product.upsert was queued in the Outbox.`);
      }
      if (parts[0] === "products" && parts[2] === "send") {
        const product = state.products.find((p) => p.sku === parts[1]);
        if (!product) return back("/products", "Unknown product.");
        const message = productMessage(product);
        state.messages.push(message);
        return back("/outbox", describe(await sendMessage(message)));
      }
      if (url.pathname === "/orders") {
        const id = (form.get("id") ?? "").trim().toUpperCase();
        if (!ORDER_ID.test(id)) return back("/orders", "Invalid order number.");
        if (state.orders.some((o) => o.id === id)) return back("/orders", `Order ${id} already exists.`);
        const lines: { sku: string; quantity: number }[] = [];
        for (const part of (form.get("lines") ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
          const [rawSku, rawQty] = part.split(":").map((x) => x.trim());
          const sku = (rawSku ?? "").toUpperCase();
          const quantity = Number(rawQty);
          if (!state.products.some((p) => p.sku === sku) || !Number.isInteger(quantity) || quantity < 1 || lines.some((l) => l.sku === sku)) {
            return back("/orders", `Bad line "${part}": use SKU:quantity with an existing ERP product, each product once.`);
          }
          lines.push({ sku, quantity });
        }
        if (lines.length === 0) return back("/orders", "An order needs at least one line.");
        const order = { id, status: "OPEN" as const, note: "Created manually in the fake ERP", lines, createdAt: new Date().toISOString() };
        state.orders.push(order);
        state.messages.push(orderCreateMessage(order));
        store.save();
        return back("/orders", `Order ${id} created and an order.create was queued in the Outbox.`);
      }
      if (parts[0] === "orders" && parts.length === 3) {
        const order = state.orders.find((o) => o.id === parts[1]);
        if (!order) return back("/orders", "Unknown order.");
        if (parts[2] === "cancel") {
          if (order.status === "CANCELLED") return back("/orders", `${order.id} is already cancelled.`);
          order.status = "CANCELLED";
          state.messages.push(orderCancelMessage(order));
          store.save();
          return back("/orders", `${order.id} cancelled locally and an order.cancel was queued in the Outbox.`);
        }
        if (parts[2] === "send" || parts[2] === "send-cancel") {
          const message = parts[2] === "send" ? orderCreateMessage(order) : orderCancelMessage(order);
          state.messages.push(message);
          return back("/outbox", describe(await sendMessage(message)));
        }
      }
      if (url.pathname === "/outbox/send-pending") {
        const pending = state.messages.filter((m) => m.status === "PENDING");
        const results: string[] = [];
        for (const m of pending) results.push(`${m.type}: ${describe(await sendMessage(m))}`);
        return back("/outbox", pending.length ? results.join("\n") : "Nothing was queued.");
      }
      if (parts[0] === "outbox" && parts[2] === "send") {
        const message = state.messages.find((m) => m.id === parts[1]);
        if (!message) return back("/outbox", "Unknown message.");
        return back("/outbox", describe(await sendMessage(message)));
      }
      if (url.pathname === "/settings/mode") {
        const mode = form.get("mode") as ResponseMode;
        if (!MODES.includes(mode)) return back("/settings", "Unknown response mode.");
        state.settings.responseMode = mode;
        state.settings.delayMs = clampInt(form.get("delayMs"), 0, 60000, 12000);
        state.settings.retryAfterSeconds = clampInt(form.get("retryAfterSeconds"), 0, 3600, 5);
        store.save();
        return back("/settings", `The fake ERP now answers WMS events with: ${mode}.`);
      }
      if (url.pathname === "/settings") {
        const next: Partial<Settings> = state.settings;
        const text = (k: string) => (form.get(k) ?? "").trim();
        if (text("wmsBaseUrl")) next.wmsBaseUrl = text("wmsBaseUrl");
        if (text("publicId")) next.publicId = text("publicId");
        if (text("inboundSecret")) next.inboundSecret = text("inboundSecret");
        if (text("outboundSecret")) next.outboundSecret = text("outboundSecret");
        if (form.get("clearInbound")) delete next.inboundSecret;
        if (form.get("clearOutbound")) delete next.outboundSecret;
        store.save();
        return back("/settings", "Connection settings saved.");
      }
      return send(404, page("Not found", "", "<p>No such action.</p>"));
    } catch (error) {
      console.error("fake-erp error:", error instanceof Error ? error.name : "error");
      return send(500, page("Error", "", "<p>The fake ERP hit an unexpected error.</p>"));
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  return { store, server, effective, sendMessage, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

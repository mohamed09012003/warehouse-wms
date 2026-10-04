// FAKE ERP (development tool): server-rendered HTML. Everything interpolated is escaped.
import { escapeHtml as h, maskSecret, redact } from "./lib";
import type { InboxEvent, Message, Order, Product, ResponseMode, Settings, State } from "./store";

export interface EffectiveSettings extends Settings {
  source: Record<"wmsBaseUrl" | "publicId" | "inboundSecret" | "outboundSecret", "saved" | "env" | "default">;
}

const CSS = `
body{font:14px/1.45 system-ui,sans-serif;margin:0;color:#1b1b1b;background:#fafafa}
.banner{background:#b00020;color:#fff;padding:8px 16px;font-weight:600}
nav{background:#222;padding:8px 16px}nav a{color:#fff;margin-right:16px;text-decoration:none}
main{padding:16px;max-width:1200px;margin:auto}
h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;width:100%;background:#fff}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f0f0f0}
form.inline{display:inline}button{cursor:pointer;padding:4px 10px}input,select,textarea{padding:4px;font:inherit}
.msg{background:#e8f4ff;border:1px solid #9cc7ee;padding:8px;margin:12px 0;white-space:pre-wrap}
.ok{color:#0a7a2f}.bad{color:#b00020}.muted{color:#666}pre{margin:0;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;background:#f6f6f6;padding:6px}
.card{background:#fff;border:1px solid #ddd;padding:12px;margin:8px 0}
`;

export function page(title: string, active: string, body: string, flash?: string | null): string {
  const links = [["/", "Dashboard"], ["/products", "Products"], ["/orders", "Orders"], ["/outbox", "Outbox (to WMS)"], ["/inbox", "Inbox (from WMS)"], ["/settings", "Settings"]];
  return `<!doctype html><html><head><meta charset="utf-8"><title>${h(title)} · FAKE ERP</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>
<div class="banner">FAKE ERP — DEVELOPMENT / TEST TOOL ONLY. Not a real ERP. Local data, local port, do not expose it, do not use real business data or real credentials.</div>
<nav>${links.map(([href, label]) => `<a href="${href}"${active === href ? ' style="text-decoration:underline"' : ""}>${h(label)}</a>`).join("")}</nav>
<main>${flash ? `<div class="msg" data-testid="flash">${h(flash)}</div>` : ""}<h1>${h(title)}</h1>${body}</main></body></html>`;
}

const post = (action: string, label: string, fields: Record<string, string> = {}, confirmText?: string) =>
  `<form class="inline" method="post" action="${h(action)}"${confirmText ? ` onsubmit="return confirm('${h(confirmText)}')"` : ""}>${Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${h(k)}" value="${h(v)}">`)
    .join("")}<button type="submit">${h(label)}</button></form>`;

const when = (iso: string) => h(iso.replace("T", " ").slice(0, 19) + " UTC");
const statusClass = (n: number | null) => (n !== null && n >= 200 && n < 300 ? "ok" : "bad");

export function dashboardView(state: State, s: EffectiveSettings): string {
  const pending = state.messages.filter((m) => m.status === "PENDING").length;
  const configured = s.wmsBaseUrl && s.publicId && s.inboundSecret;
  const last = state.messages.flatMap((m) => m.attempts.map((a) => ({ m, a }))).sort((x, y) => y.a.at.localeCompare(x.a.at))[0];
  return `<div class="card"><b>Connection to the WMS</b><br>
Webhook target: <code>${h(s.wmsBaseUrl)}/api/webhooks/${h(s.publicId || "(public id not set)")}</code> ·
signing secret ${h(maskSecret(s.inboundSecret))} · ${configured ? '<span class="ok">ready to send</span>' : '<span class="bad">not configured: open Settings</span>'}<br>
Receiving WMS events at <code>POST /wms/events</code> · verification secret ${h(maskSecret(s.outboundSecret))} · response mode <b data-testid="mode">${h(s.responseMode)}</b></div>
<table><tr><th>Products</th><th>Orders (open)</th><th>Queued to send</th><th>WMS events received</th></tr>
<tr><td>${state.products.length}</td><td>${state.orders.filter((o) => o.status === "OPEN").length} of ${state.orders.length}</td><td>${pending}</td><td>${state.inbox.length}</td></tr></table>
${last ? `<p>Last send to the WMS: <code>${h(last.m.type)}</code> at ${when(last.a.at)} → <b class="${statusClass(last.a.httpStatus)}">${h(last.a.httpStatus ?? last.a.error)}</b></p>` : '<p class="muted">Nothing has been sent to the WMS yet.</p>'}
<h2>Actions</h2>${post("/outbox/send-pending", "Send all queued messages to the WMS")} ${post("/reset", "Reset demo data", {}, "Reset products, orders, queued messages and received events? Connection settings are kept.")}`;
}

export function productsView(state: State): string {
  return `<table data-testid="products"><tr><th>SKU</th><th>Name</th><th>Barcodes</th><th></th></tr>${state.products
    .map((p: Product) => `<tr><td>${h(p.sku)}</td><td>${h(p.name)}</td><td>${h(p.barcodes.join(", "))}</td><td>${post(`/products/${encodeURIComponent(p.sku)}/send`, "Send product.upsert to the WMS")}</td></tr>`)
    .join("")}</table>
<h2>Create a product</h2><form method="post" action="/products">
SKU <input name="sku" required maxlength="64" placeholder="DEMO-004"> Name <input name="name" required maxlength="200"> Barcode <input name="barcode" maxlength="128">
<button type="submit">Create (queues a product.upsert)</button></form>`;
}

export function ordersView(state: State): string {
  return `<table data-testid="orders"><tr><th>Order</th><th>Status</th><th>Lines</th><th></th></tr>${state.orders
    .map(
      (o: Order) =>
        `<tr data-order="${h(o.id)}"><td>${h(o.id)}</td><td>${h(o.status)}</td><td>${h(o.lines.map((l) => `${l.sku} × ${l.quantity}`).join(", "))}</td><td>${post(`/orders/${encodeURIComponent(o.id)}/send`, "Send order.create")} ${
          o.status === "OPEN" ? `${post(`/orders/${encodeURIComponent(o.id)}/cancel`, "Cancel order (queues order.cancel)")}` : ""
        } ${post(`/orders/${encodeURIComponent(o.id)}/send-cancel`, "Send order.cancel")}</td></tr>`,
    )
    .join("")}</table>
<h2>Create an order</h2><form method="post" action="/orders">
Order number <input name="id" required maxlength="40" placeholder="ERP-ORDER-003"> Lines <input name="lines" required size="40" placeholder="DEMO-001:5, DEMO-002:2">
<button type="submit">Create (queues an order.create)</button></form><p class="muted">Lines use ERP product SKUs and are sent with both the ERP product id and the SKU.</p>`;
}

function attemptsHtml(m: Message): string {
  if (m.attempts.length === 0) return '<span class="muted">not sent yet</span>';
  return m.attempts
    .map((a) => `<div><span class="${statusClass(a.httpStatus)}">${h(a.httpStatus ?? "no response")}</span> ${when(a.at)} (${a.durationMs} ms)${a.error ? ` ${h(a.error)}` : ""}<pre>${h(a.body)}</pre></div>`)
    .join("");
}

export function outboxView(state: State): string {
  const rows = [...state.messages].reverse();
  return `<p>${post("/outbox/send-pending", "Send all queued messages")}</p><table data-testid="outbox"><tr><th>Event id</th><th>Type</th><th>Status</th><th>Payload</th><th>WMS responses</th><th></th></tr>${rows
    .map(
      (m) =>
        `<tr data-message="${h(m.id)}" data-status="${h(m.status)}"><td><code>${h(m.id)}</code></td><td>${h(m.type)}</td><td>${h(m.status)}</td><td><pre>${h(JSON.stringify(redact(m.data), null, 1))}</pre></td><td>${attemptsHtml(m)}</td><td>${post(`/outbox/${m.id}/send`, m.status === "PENDING" ? "Send" : "Re-send (same event id)")}</td></tr>`,
    )
    .join("")}</table>`;
}

export function inboxView(state: State): string {
  const rows = [...state.inbox].reverse();
  if (rows.length === 0) return '<p class="muted">No events received from the WMS yet. Point the WMS integration\'s target URL at <code>http://127.0.0.1:4100/wms/events</code>.</p>';
  return `<table data-testid="inbox"><tr><th>Event id</th><th>Type</th><th>Received</th><th>Signature</th><th>ERP answered</th><th>Payload (redacted)</th></tr>${rows
    .map(
      (e: InboxEvent) =>
        `<tr data-event-type="${h(e.type)}" data-verification="${h(e.verification)}"><td><code>${h(e.id)}</code>${e.duplicate ? " <b>(duplicate delivery)</b>" : ""}<br><span class="muted">delivery ${h(e.deliveryId)} · attempt ${h(e.attempt)}</span></td><td>${h(e.type)}</td><td>${when(e.receivedAt)}</td><td class="${e.verification === "VALID" ? "ok" : "bad"}">${h(e.verification)}</td><td class="${statusClass(e.respondedWith)}">${h(e.respondedWith)} <span class="muted">(mode ${h(e.mode)})</span></td><td><pre>${h(JSON.stringify(e.payload, null, 1))}</pre></td></tr>`,
    )
    .join("")}</table>`;
}

export function settingsView(s: EffectiveSettings): string {
  const modes: [ResponseMode, string][] = [["200", "200 OK"], ["400", "400 Bad Request (the WMS marks the delivery DEAD)"], ["429", "429 Too Many Requests + Retry-After (the WMS retries)"], ["500", "500 Server Error (the WMS retries)"], ["delay", "Delayed 200 (longer than the WMS 10 s timeout by default)"]];
  return `<div class="card"><b>What the fake ERP answers to events sent by the WMS</b> (only events with a valid signature; a wrong signature is always 401)
<form method="post" action="/settings/mode">${modes.map(([v, l]) => `<div><label><input type="radio" name="mode" value="${v}"${s.responseMode === v ? " checked" : ""}> ${h(l)}</label></div>`).join("")}
Delay (ms) <input name="delayMs" type="number" min="0" max="60000" value="${s.delayMs}"> Retry-After (s) <input name="retryAfterSeconds" type="number" min="0" max="3600" value="${s.retryAfterSeconds}">
<button type="submit">Save response behaviour</button></form></div>
<div class="card"><b>Connection to the WMS</b> <span class="muted">(saved in the local data file; blank secret fields keep the current value; defaults come from the environment, see .env.example)</span>
<form method="post" action="/settings">
<div>WMS base URL <input name="wmsBaseUrl" size="40" value="${h(s.wmsBaseUrl)}"> <span class="muted">(${s.source.wmsBaseUrl})</span></div>
<div>Integration public id <input name="publicId" size="40" value="${h(s.publicId)}"> <span class="muted">(${s.source.publicId}; the last part of the integration's webhook path in the WMS)</span></div>
<div>WMS inbound signing secret <input name="inboundSecret" type="password" autocomplete="off" size="40" placeholder="${h(maskSecret(s.inboundSecret))}"> <label><input type="checkbox" name="clearInbound"> clear</label> <span class="muted">(${s.source.inboundSecret}; the ERP SIGNS what it sends to the WMS with this)</span></div>
<div>WMS outbound signing secret <input name="outboundSecret" type="password" autocomplete="off" size="40" placeholder="${h(maskSecret(s.outboundSecret))}"> <label><input type="checkbox" name="clearOutbound"> clear</label> <span class="muted">(${s.source.outboundSecret}; the ERP VERIFIES what the WMS sends with this)</span></div>
<button type="submit">Save connection</button></form></div>
<div class="card">${post("/reset", "Reset demo data", {}, "Reset products, orders, queued messages and received events? Connection settings are kept.")}</div>`;
}

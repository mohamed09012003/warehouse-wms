# Fake ERP (development / test tool)

A tiny, **fake** external ERP for trying the WMS Phase 6 integration layer end to end by hand, with no real ERP account and no real data. It is **not** part of the WMS: separate process, separate port, its own JSON data file (`tools/fake-erp/data/erp.json`, git-ignored), no WMS database access, no WMS imports. It speaks the **existing** Phase 6 contract exactly (see `docs/integrations.md`):

```
Fake ERP ──signed POST /api/webhooks/{publicId}──▶ WMS integration layer ──▶ WMS PostgreSQL
Fake ERP ◀──signed POST /wms/events (order.created, order.allocated, …)── WMS worker
```

Development only: it binds to `127.0.0.1`, refuses other hosts unless you set `FAKE_ERP_ALLOW_REMOTE=true`, shows a red "FAKE ERP" banner on every page, never prints or displays secrets, and rejects cross-site form posts. Never expose it, never use real credentials or customer data.

## Start it

```
npm run fake-erp          # http://127.0.0.1:4100
```

Optional: copy `tools/fake-erp/.env.example` to `tools/fake-erp/.env` (git-ignored) to preset the connection. Everything can also be typed into the fake ERP's **Settings** page (saved in the local data file; the saved value wins over `.env`). The WMS `.env` is never touched by this tool.

## One-time WMS setup (your WMS `.env`, then restart the dev server and the worker)

1. `INTEGRATION_ENCRYPTION_KEYS="k1:<base64 of 32 random bytes>"` (generator command in the WMS `.env.example`). Required for any integration.
2. `INTEGRATIONS_ALLOW_PRIVATE_TARGETS="true"`. **Needed**: the WMS refuses to call `http://127.0.0.1` otherwise (SSRF protection; development only, ignored in production).
3. Run the worker in another terminal: `npm run worker` (it processes inbound events and delivers outbound ones; nothing happens without it).

## Connect them (WMS page `/<your-org>/integrations`)

1. **Create integration**: provider *Generic signed webhook*, tick **both** inbound and outbound.
2. **Configuration**: Target URL `http://127.0.0.1:4100/wms/events`; tick the events you want sent (`order.created`, `order.allocated`, `order.picked`, `order.packed`, `order.cancelled`); Save.
3. **Secrets** (the WMS never shows a secret again, so copy it at this moment):
   - *Inbound signing secret* (what the ERP signs with): click **Generate**, click **Save**, then copy the value from the "shown once" box into the fake ERP **Settings → WMS inbound signing secret** (or `WMS_INBOUND_SECRET`).
   - *Outbound signing secret* (what the WMS signs with): type any 16+ character value (or **Generate**), **Save** (copy it from the box if generated), and put the same value into **Settings → WMS outbound signing secret** (or `WMS_OUTBOUND_SECRET`).
   - Lost a value? Just save a new one in the WMS and copy that (the old inbound value stays valid for 24 h).
4. **Public id**: the WMS page shows `/api/webhooks/<public id>`; copy the last part into **Settings → Integration public id** (or `WMS_INTEGRATION_PUBLIC_ID`). The base URL defaults to `http://localhost:3000`.
5. **Enable** the integration, then **Send test event** in the WMS: it appears in the fake ERP **Inbox** with signature `VALID`.

## What to try

| Do this | See this |
|---|---|
| ERP **Outbox → Send all queued messages** (3 `product.upsert`, 2 `order.create`) | WMS answers **202**; the WMS integration page lists the events as `RECEIVED`. Run/wait for the worker: they become `SUCCEEDED`, products and orders (`ERP-ORDER-001`, `ERP-ORDER-002`) appear in the WMS |
| **Re-send (same event id)** in the Outbox | WMS answers **200 duplicate** (idempotency) |
| ERP **Orders → Cancel order**, then send the queued `order.cancel` | The WMS order becomes Cancelled (an order that is already picked/packing/packed is `REJECTED` with `INVALID_STATE`) |
| Allocate / pick / pack in the WMS | `order.allocated`, `order.picked`, `order.packed` (with packages) arrive in the ERP **Inbox** after the worker runs |
| ERP **Settings → response behaviour** | `400` → the WMS delivery goes `DEAD` (replay it from the WMS page); `500` / `429` (+Retry-After) → `FAILED`, retried with backoff; *Delayed* (default 12 s) → the WMS times out after 10 s and retries; a wrong outbound secret → ERP flags `INVALID_SIGNATURE` and answers 401 |
| Sign with a wrong inbound secret / unknown public id | WMS answers the uniform **401** |
| **Reset demo data** | Deterministic seed again (3 products DEMO-001…003, 2 orders); connection settings are kept |

The ERP **Inbox** shows event id, type, received time, signature verification result, the status the ERP answered, delivery id/attempt and the payload (secret-looking fields redacted). The **Outbox** shows every message with each WMS response.

## Limits

It is a fixture, not an ERP: no authentication, no real stock logic, one integration at a time, state in a single JSON file. `tests/fakeErp.test.ts` keeps it honest against the real Phase 6 signature, webhook and delivery code.

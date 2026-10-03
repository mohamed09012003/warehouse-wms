# Integrations (design only — not implemented in Phase 0)

## Principles

- The WMS PostgreSQL database is the **WMS source of truth** (stock, locations, picking, packing). Customers keep their own ERP/e-commerce systems; we never require migrating them.
- **The core never knows about any customer system.** Core modules expose *ports* (service APIs and domain events). Integrations sit *outside* the core in `src/integrations/` and depend on the core, never the reverse.
- Integrations are **per organization**, configured in data (`Integration` rows), and tenant-bound.
- All inbound operations are **idempotent** and validated with Zod; all outbound delivery is **reliable** (outbox) and **retried**.

## Layers

```
 External system ⇄ [Adapter] ⇄ [Mapping/ExternalRef] ⇄ [Core service API]  (core: modules/*)
 REST API consumers ───────────────────────────────────► same service API
 Webhooks out  ◄── Outbox dispatcher ◄── OutboxEvent (written in core transactions)
```

### Channels

| Channel | Direction | Notes |
|---|---|---|
| **REST API** `/api/v1` | in/out | Versioned, API-key (hashed, scoped, per-org) auth; pagination, filtering, `Idempotency-Key` header; OpenAPI spec generated from Zod schemas; rate limits. Same services as the UI, so rules are identical. |
| **Webhooks (outbound)** | out | Org-registered endpoints subscribe to event types (`order.shipped`, `inventory.changed`, `package.closed`…). HMAC-signed payloads, timestamp, event id, retries with exponential backoff, delivery log (`WebhookDelivery`), manual replay, auto-disable on sustained failure. |
| **Webhooks (inbound)** | in | `/api/webhooks/<integration>`; signature verification; store raw event, process async via Job; dedupe by external event id. |
| **CSV import/export** | in/out | Import jobs: upload → parse → validate row-by-row with Zod → dry-run report → commit (transactional per batch, row-level error report). Imports for products, barcodes, orders, opening stock (as RECEIPT/ADJUSTMENT movements — never direct balance writes). Exports stream from read queries. |
| **Scheduled sync** | in/out | `SyncRun` records per integration/entity; cursor/watermark based; run by the Job runner on a schedule; overlapping runs prevented by lock row. |
| **ERP / e-commerce adapters** | in/out | Implement the adapter port; translate foreign models ↔ core DTOs. One folder per system under `integrations/adapters/`. |
| **External SQL/DB connectors** | in (mainly) | For customers who can only expose a database. Read-only connection by default, **per-integration least-privilege credentials**, queries defined as reviewed templates/mappings, run from the Job runner with timeouts and row limits. We never write into a customer database unless explicitly agreed and implemented as a specific adapter. Never run user-supplied SQL. |

### Adapter port (sketch)

```ts
interface IntegrationAdapter {
  type: string;                                   // 'shopify', 'sap-b1', 'sql-generic', ...
  configSchema: ZodSchema;                        // validates Integration.config
  capabilities: { pullOrders?, pullProducts?, pushShipments?, pushStock?, handleWebhook? };
  pullOrders?(ctx: IntegrationContext, since: Cursor): AsyncIterable<ExternalOrder>;
  pushShipment?(ctx, shipment: CoreShipmentDTO): Promise<void>;
  handleWebhook?(ctx, req: VerifiedRequest): Promise<void>;
}
```
Adapters call core services (`orders.createFromExternal`, `catalog.upsertProduct`, `inventory.receive`) with a `ctx` identifying the integration as actor. They hold no business rules.

## Identity mapping

`ExternalRef(org, integrationId, entityType, internalId, externalId)` unique per external id. Orders also carry `(source, externalId)` unique per org so re-imports update rather than duplicate. Internal IDs are never exposed as the integration contract's only identifier — external references and business keys (`sku`, order `number`) are.

## Reliability

- **Outbox**: events inserted in the same transaction as the state change; a dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, delivers, marks done or schedules retry. At-least-once; consumers dedupe by event id.
- **Inbound idempotency**: `Idempotency-Key` (REST), external event id (webhooks), natural keys (orders).
- **Conflict policy**: WMS owns stock/location/fulfilment state; the ERP owns product master/orders by default (configurable per integration: e.g. product master source = ERP, WMS pushes stock levels). Write the chosen policy in the `Integration` config, not in code.
- **Failure visibility**: `SyncRun`/`WebhookDelivery`/`ImportJob` rows expose status, counts, errors in the UI.

## Security

- Credentials encrypted at rest (app-level envelope encryption with a key from env/KMS; key id stored with ciphertext); never logged, never returned by APIs.
- API keys: shown once, stored hashed, prefix for lookup, scopes limit access, revocable.
- Webhook secrets per endpoint, rotatable. SSRF protection on outbound webhook URLs (block private ranges, enforce https in production).
- Every integration identity is bound to one organization and uses the same tenant-scoped services as users.

## What exists when

Nothing in Phase 0. Roadmap: REST API + API keys + outbox/webhooks first (they are the foundation for everything else), then CSV, then scheduled sync and adapters driven by actual customer needs.

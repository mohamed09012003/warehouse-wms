# Integrations

Implemented in Phase 6 (awaiting review): integration records, an encrypted secrets vault, signed inbound webhooks, inbound product/order/cancel events, a transactional outbox, outbound signed webhooks, a durable PostgreSQL-backed worker with retries, health tracking and replay, and a minimal admin UI.

**Not implemented (deferred, see the end):** REST `/api/v1` and API keys, OAuth, CSV import/export, external SQL connectors, a generic `Job` table / scheduled sync, ERP / e-commerce / carrier adapters, `inventory.changed` events, inbound inventory adjustments, warehouse/location mapping, status-mapping tables, strict outbound ordering, rate limiting, RLS and the database role split.

## Principles

- The WMS PostgreSQL database is the source of truth for stock, locations, picking and packing. External systems never write WMS tables; they talk to an adapter boundary, and adapters call the same public module services the UI uses.
- **The core never imports `src/integrations/`** (ESLint rule + a source-scan test). The core publishes domain events through `modules/outbox`; integrations consume them.
- Every integration belongs to exactly one organization. The organization always comes from the integration row (webhook `publicId`) or the authenticated session, never from request input.
- **An external system being offline never stops receiving, moving, reserving, picking or packing.** Core transactions never call out; they only insert an outbox row.
- Inbound work is authenticated, idempotent, validated with Zod and safe to retry. Outbound delivery is at-least-once; consumers dedupe on the stable event id.

## Layers

```
External ──signed POST──▶ /api/webhooks/{publicId}      verify → validate envelope → INSERT InboundEvent → 202
                                      │ worker (claims with FOR UPDATE SKIP LOCKED, 60 s lease)
        generic-webhook handlers ──▶ core services (catalog / orders / picking.cancelOrder) as the integration actor
                                      └── ExternalRef (external id ↔ WMS id), written in the same transaction

Core transaction ──INSERT OutboxEvent (same tx)──▶ worker fan-out ──▶ IntegrationDelivery ──▶ adapter.deliver() ──▶ External
```

| Folder | Role |
|---|---|
| `src/modules/outbox` | Write side of the outbox: `recordEvent(tx, ctx, event)`. Knows nothing about providers. |
| `src/integrations/core` | Ports (`InboundAdapter`, `OutboundAdapter`, `HttpClient`), registry, retry policy, health thresholds, grants allowlist, error classification, safe logger |
| `src/integrations/adapters/generic-webhook` | The only provider in Phase 6: config schema, HMAC signing, inbound handlers, outbound delivery |
| `src/integrations/secrets` | AES-256-GCM vault (`vault.ts`) and the secret store (`secretStore.ts`: the single decryption boundary) |
| `src/integrations/http` | `SafeHttpClient` (the only code that touches the network) and the address policy |
| `src/integrations/repo` | All Prisma access of the layer (tenant-scoped repos; system-level repos for the webhook and the worker) |
| `src/integrations/service` | Admin services, webhook ingestion, inbound processor, delivery processor, fan-out, health bookkeeping |
| `src/integrations/worker` | `runOnce()` and the loop behind `npm run worker` |

Adding a provider means adding a `ProviderDefinition` (config schema, secret names, `readiness`, optional `inbound` / `outbound` adapters) to `core/registry.ts`. Nothing in the core domain changes.

## Data model

All tables carry `organizationId` and tenant composite foreign keys. Details in [database.md](database.md#phase-6--integrations).

| Table | Purpose |
|---|---|
| `Integration` | provider, `publicId`, direction flags, `enabled` / `disabledReason`, non-secret `config`, `grants`, `serviceUserId`, health fields, `outboundPausedAt`, `archivedAt` |
| `IntegrationSecret` | name + slot (`CURRENT` / `PREVIOUS`) + ciphertext/iv/authTag/keyId. Never selected by any other code |
| `ExternalRef` | external id ↔ `Product` or `Order`; typed nullable FK columns + CHECK (exactly one, matching `entityType`) |
| `InboundEvent` | one row per received external event: payload hash, validated envelope, status machine, attempts, lease |
| `OutboxEvent` | domain events written by core services (append-only apart from the one-time `fannedOutAt` marker) |
| `IntegrationDelivery` | one row per (integration, outbox event): status machine, attempts, lease, last HTTP status/error |
| `IntegrationLog` | append-only operational log of safe summaries |

## The integration actor

Each integration acts as a dedicated **non-login service `User`** (`integration-<uuid>@integration.invalid`, `disabledAt` set, password hash that can never verify, **no membership**, so it also never appears in member lists). `resolveIntegrationContext` builds a `TenantContext` from the integration row with exactly the permissions in `Integration.grants`.

- Allowed grants: **`products.manage`, `orders.manage`** (plus their `.view` counterparts). Nothing else can ever be granted: not `inventory.*`, `warehouse.*`, `picking.manage`, `packing.manage`, members/roles/org or `integrations.*`. Enforced in code and by a database CHECK on `Integration.grants`.
- A new integration receives its provider's default grants. Any other grant set can only be set by an **Owner**.
- The actor's user id is recorded on what it creates (for example `Order.createdByUserId`).

## Inbound: `POST /api/webhooks/{publicId}`

`publicId` (128 random bits) is the **only** lookup key; the organization slug is never used. Authentication is the signature, not a session.

```
X-WMS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
```

Verification uses a constant-time comparison, rejects timestamps outside ±5 minutes, and accepts the CURRENT secret and, for 24 h after a rotation, the PREVIOUS one. Body: UTF-8 JSON, at most 256 KiB.

```json
{ "eventId": "evt-123", "type": "order.create", "occurredAt": "2026-10-06T12:00:00Z", "data": { } }
```

| Response | Meaning |
|---|---|
| `202 {status:"accepted"}` | Validated and stored; the worker processes it later. **Nothing business-related happens inside the request.** |
| `200 {status:"duplicate"}` | Same `(integration, eventId)` and the same payload hash: safe to ignore |
| `409 CONFLICT` | Same `eventId` with a different payload |
| `400 VALIDATION_FAILED` | Signed, but not valid JSON / not a valid envelope |
| `401 AUTHENTICATION_REQUIRED` | Unknown or malformed `publicId`, disabled, archived or inbound-disabled integration, wrong/missing signature, stale or future timestamp, unreadable vault: **all answered identically** |
| `413 PAYLOAD_TOO_LARGE` | Over 256 KiB (checked while streaming) |

Once an envelope is persisted, semantic or business problems never produce webhook errors: the event becomes `REJECTED` (visible, replayable) so senders do not retry forever.

### Inbound event types (provider `generic-webhook`)

| Type | `data` | Effect |
|---|---|---|
| `product.upsert` | `externalId`, `sku`, `name`, `description?`, `barcodes?` | `catalog.upsertProduct` + `ExternalRef`. Barcodes are **add-only**. SKU cannot change for a mapped product. A barcode owned by another product rejects the event. |
| `order.create` | `externalId`, `orderNumber?` (default: the external id), `note?`, `ready?` (default `true`), `lines[{ externalProductId? \| sku?, quantity }]` | Products resolve through `ExternalRef` or SKU/barcode; `orders.createOrder` + `ExternalRef` in one transaction. A second event for the same `externalId` is a no-op that reports the same order. |
| `order.cancel` | `externalId` | `picking.cancelOrder`. An already cancelled order is a success. An order in `PICKED`, `PACKING` or `PACKED` is `REJECTED` (`INVALID_STATE`) with nothing changed. |

Handlers only translate DTOs and keep the mapping; every rule lives in the core services. Unsupported types are `REJECTED` (`UNSUPPORTED_EVENT_TYPE`). There is no inbound inventory adjustment.

### Inbound event states

`RECEIVED → PROCESSING → SUCCEEDED`, or `REJECTED` (permanent: bad payload, unknown reference, rule violation; not retried), or `FAILED` (transient: retried with backoff) and finally `DEAD` (attempts exhausted). A lease-expired `PROCESSING` event is reaped to `FAILED`/`DEAD`. Every transition out of `PROCESSING` is guarded by `(status, attempts)`, so a worker that lost its lease can never overwrite the new owner's result, and the handler's writes roll back with the lease check.

## Outbound: outbox → deliveries

Core services record exactly one outbox event per successful business transition, **in the same transaction**:

| Event | Emitted when | Payload (thin) |
|---|---|---|
| `order.created` | an order is created (UI or integration) | order id/number/external ref, status, lines (sku, quantities) |
| `order.allocated` | each successful allocation step | status, allocation state, `allocatedNow`, totals, lines |
| `order.picked` | the pick that completes the order (every requested unit picked) | status (`PICKED` or `PACKING`), `pickedTotal`, lines |
| `order.packed` | packing completes with every requested unit picked and packed | status, lines, **all completed packages** (number, type, grams, mm, items) |
| `order.cancelled` | an order is cancelled | `previousStatus`, `tasksCancelled`, lines |

A rollback removes the event with the change; an idempotent replay of an already completed operation never writes a second one. Payloads contain ids, business identifiers, quantities and package data only. Never credentials, raw external payloads or unnecessary personal data (`recordEvent` also rejects secret-looking keys). Not emitted: `inventory.changed`, partial-packing sessions (only `order.packed`), allocation release.

**Fan-out.** The worker finds `OutboxEvent` rows with `fannedOutAt IS NULL` (no cursor), and for each enabled outbound, non-archived integration of the same organization whose adapter `subscribes` to the type it creates one `IntegrationDelivery` (unique `(integrationId, outboxEventId)`), then marks the event. A paused (circuit-breaker) integration still queues deliveries; a disabled or archived one does not receive events fanned out meanwhile. Events are delivered to integrations that exist and are enabled when the event is fanned out.

**Delivery** (`generic-webhook`): `POST targetUrl` with

```
Content-Type: application/json
X-WMS-Event-Id:    <stable outbox event id, identical on every attempt>
X-WMS-Event-Type:  order.packed
X-WMS-Delivery-Id: <fresh per attempt>
X-WMS-Attempt:     1
X-WMS-Signature:   t=<unix>,v1=<HMAC-SHA256 of "<t>.<raw body>" with the outbound secret>
{ "eventId", "type", "schemaVersion", "occurredAt", "sequence", "data": { …payload } }
```

Only those headers are ever sent. Delivery is **at-least-once** (a worker that loses its lease may have sent a duplicate: same event id); there is no strict ordering (`sequence` and `occurredAt` help consumers).

| Remote answer | Outcome |
|---|---|
| 2xx | `SUCCEEDED` |
| 408, 429, 5xx, network error, timeout, DNS failure, oversized response | retry (`FAILED` + backoff; `Retry-After` honoured, capped at 1 h) |
| other 4xx, 3xx (redirects are never followed), blocked/invalid target | `DEAD` at once (replayable) |

## Worker, retries and health

`npm run worker` runs the loop; `npm run worker -- --once` does one pass (it needs `INTEGRATION_ENCRYPTION_KEYS` and works on whatever `DATABASE_URL` points at; it logs only the database *name*). Tests call `runOnce()` directly. One pass: **reap** expired leases → process due inbound events → **fan out** outbox events → send due deliveries → optional **purge** (fan-out comes after inbound processing so an event written by an imported order, e.g. `order.created`, is delivered in the same pass). Items are claimed one at a time with `FOR UPDATE SKIP LOCKED`; any number of workers may run.

- **Lease:** 60 s. A row stuck in `PROCESSING` past its lease is reclaimed (counts as an attempt).
- **Backoff after attempt n:** 30 s, 2 m, 10 m, 30 m, 2 h, 6 h, 12 h (then 12 h). **Max attempts:** 8 by default, `config.maxAttempts` 1–12 per integration; then `DEAD`.
- **Health is tracked separately for each direction** (inbound and outbound have their own status, consecutive-failure counter, last success, last failure and safe error summary; columns `inbound*` / `outbound*` on `Integration`). Thresholds per direction (any success in that direction resets that direction's counter): 0–2 consecutive failures `HEALTHY`, 3–9 `DEGRADED`, 10+ `FAILING`. Counted failures: transient processing failures, dead events/deliveries and lease expiries in that direction, and failed connection tests (outbound). `REJECTED` inbound events (bad data from the sender) do not count. The two sides never influence each other: an inbound outcome never changes an outbound column, and vice versa.
- **Circuit breaker (outbound only):** at 10 consecutive **outbound** failures `outboundPausedAt` is set. Inbound failures can never pause outbound delivery, and inbound successes never reset the breaker or the outbound counter (nor do outbound successes reset the inbound counter). Paused integrations are not claimed for delivery; their deliveries stay `PENDING`/`FAILED` and nothing is lost; inbound processing continues. **Enable** (shown as *Resume*) clears the pause and the outbound counter/health only; inbound health is left as it is. The admin page shows an Inbound and an Outbound health block (status, last success/failure, consecutive failures, last error) and a "delivery paused" marker.
- **Retention** (only when `purge` is requested; the loop does it every 10 minutes): `SUCCEEDED` deliveries 7 days, `DEAD` deliveries 30 days, fanned-out outbox events 7 days once no delivery references them. Pending/failed/processing work is never purged. **Inbound events and log rows are not purged yet** (the log is append-only; partitioning/retention is Phase 7).

## Idempotency

| Case | Mechanism |
|---|---|
| Inbound event id | unique `(organizationId, integrationId, externalEventId)` + SHA-256 of the raw body: duplicate → 200, different payload → 409 |
| Inbound business effect | `ExternalRef` unique keys + natural keys (order number, SKU); cancel of a cancelled order is a success; a lost lease rolls the handler back |
| Outbound event id | the outbox event id, identical across attempts; one delivery row per (integration, event) |
| Duplicate/retried delivery | allowed (at-least-once); consumers dedupe on `X-WMS-Event-Id` |
| Failed processing | rolls back; event stays claimable; backoff; replay after `REJECTED`/`DEAD` gives a fresh attempt budget |

## Security

- **Vault.** `INTEGRATION_ENCRYPTION_KEYS="keyId:base64(32 bytes)[,keyId2:…]"`; the first key encrypts, the rest only decrypt (rotation). AES-256-GCM, random 96-bit IV, **AAD = organization id + integration id + secret name**: a ciphertext copied to another tenant, integration or name fails authentication. `secretStore.ts` is the only code that reads `IntegrationSecret` or decrypts (a test enforces it). Without keys the vault, the webhook endpoint (fails closed) and the worker refuse to work; the rest of the app is unaffected. Generate a key: `node -e "console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))"`.
- **Secrets are write-only.** `PUT/DELETE …/secrets/{name}`; every read returns only `{name, isSet, rotatedAt, hasPrevious}`. The inbound signing secret can be generated **in the browser** (shown once in that tab, then discarded); the server never returns a value. Rotation keeps the previous value valid for 24 h.
- **Configuration is secret-free.** `Integration.config` rejects secret-looking keys at any depth, unknown keys, and target URLs with credentials, query strings or fragments. Secrets never appear in API responses, errors, logs, `IntegrationLog` or any ordinary table (canary tests cover all of them, including a remote that echoes secrets back).
- **Logging.** The log stream and `IntegrationLog` carry only ids, codes, counts and short redacted summaries. Remote response bodies, headers and inbound payloads are never stored or logged. `toErrorResponse` no longer logs raw `error.message` (Prisma messages can contain SQL and bound parameters): it logs the code, error class and Prisma/SQL code with a **correlation id** that 5xx responses also carry.
- **SSRF.** All outbound traffic goes through `SafeHttpClient`: https only in production; the hostname is resolved once, **every** address must be public (loopback, private, link-local incl. cloud metadata, CGNAT, multicast, reserved, IPv4-mapped/NAT64 forms are refused), and the connection is **pinned** to the validated address; no redirects; 10 s timeout; 64 KiB response cap; bodies are drained and discarded. `INTEGRATIONS_ALLOW_PRIVATE_TARGETS=true` (dev/test only, ignored in production) permits loopback/http for local testing.
- **CSRF.** `tenantRoute` refuses state-changing requests whose `Sec-Fetch-Site` is not `same-origin`/`none` or whose `Origin` is not this host (403). Non-browser clients are unaffected. The public webhook uses no cookies.
- **Permissions.** `integrations.view`, `integrations.manage`: Owner and Admin only (Member has neither). Changing grants is Owner-only. Inbound payloads are shown only with `manage`.

## Admin API (`/api/internal/{orgSlug}/integrations`, session-authenticated, tenant-scoped, Zod-validated)

`GET`/`POST` (list, create) · `/{id}` `GET`/`PATCH` · `/{id}/enable` · `/{id}/disable` · `/{id}/secrets/{name}` `PUT`/`DELETE` · `/{id}/test` (signed `integration.test` event, synchronous, no delivery row) · `/{id}/inbound-events` · `/{id}/inbound-events/{eventId}` · `/{id}/inbound-events/{eventId}/replay` · `/{id}/deliveries` · `/{id}/deliveries/{deliveryId}/replay` · `/{id}/logs`.

Pages: `/{orgSlug}/integrations` (list, create) and `/{orgSlug}/integrations/{id}` (status, configuration, write-only secrets, enable/disable/resume, test event, inbound events, deliveries, log, replay).

## Environment

| Variable | Purpose |
|---|---|
| `INTEGRATION_ENCRYPTION_KEYS` | vault keyring (see above). Optional at startup (format validated when present); required to use integrations |
| `INTEGRATIONS_ALLOW_PRIVATE_TARGETS` | `true` allows loopback/private/http targets. Development and tests only |

## Known limitations

- Admin changes (create, enable, secret set/delete) are written to the structured log stream (ids only), not to a database audit table.
- Inbound events and `IntegrationLog` rows are retained indefinitely; inbound payloads may contain whatever the sender included (up to 256 KiB).
- No rate limiting on the webhook endpoint; per-integration delivery concurrency is not limited and there is no strict ordering.
- The `IntegrationLog` trigger blocks row UPDATE/DELETE but, like the inventory ledger, not `TRUNCATE` or a table owner (Phase 7).
- After a lost lease a delivery may be sent twice (same event id).

## Deferred

REST `/api/v1` + API keys + OpenAPI · OAuth · CSV import/export · external SQL connector · generic `Job` table / scheduled sync · ERP, e-commerce and carrier adapters · `inventory.changed` events · inbound inventory adjustments · inbound order edits · warehouse/location mapping · status-mapping tables · strict ordering · rate limiting · RLS · database role split · log/payload retention policy · Phase 7 hardening items (see [roadmap.md](roadmap.md)).

Design notes for the deferred connectors (unchanged intent): CSV rows become the same inbound envelopes (`externalEventId` = job id + row hash) so dedupe, per-row status and replay come for free; an SQL connector is a pull adapter in the worker with a read-only least-privilege account, named query templates (never free SQL), statement/lock timeouts and row caps, credentials in the vault and an explicit Owner-approved host allowlist.

## Manual testing: the fake ERP

`tools/fake-erp/` (`npm run fake-erp`, http://127.0.0.1:4100) is a development-only fake external system for trying this layer by hand: it sends signed `product.upsert` / `order.create` / `order.cancel` webhooks to `POST /api/webhooks/{publicId}` and receives the WMS's signed outbound events at `POST /wms/events` (verifying the signature, logging every event, and answering 200/400/429/500/delayed on demand). It is a separate process with its own JSON data file, imports nothing from the WMS, and uses the contract exactly as documented above. Setup, the secret-copying steps and a walkthrough are in `tools/fake-erp/README.md`; `tests/fakeErp.test.ts` checks it against the real signature, webhook and delivery code. It is not part of the product and changes none of the contracts.

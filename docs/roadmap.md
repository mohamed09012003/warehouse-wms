# Roadmap

Rules (from CLAUDE.md): each phase is implemented, tested, reviewed and committed **separately**. After each phase, stop and wait for the user's go-ahead. Scope below is a proposal; adjust at review.

Phase numbers below are the project's actual phases (they match the commit history). The Phase 0 plan numbered them differently (the visual designer was merged into Phase 2, so everything after it moved up by one; the old "API and events" and "Data exchange" phases became Phase 6 and Phase 8).

| Phase | Name | Status |
|---|---|---|
| 0 | Architecture, domain model, docs, rules | Done |
| 1 | Project foundation + tenancy + auth | Done |
| 2 | Warehouse structure + visual designer (floor plan, racks/levels/bays/positions, rack elevation, pallet types) | Done |
| 3 | Catalog + inventory core (products, barcodes, balances, movements, receive/move/adjust, reservations) | Done |
| 4 | Orders + picking (allocation, waves, pick tasks, pick confirmation) | Done |
| 5 | Packing (sessions, packages, contents); labels are deferred | Done |
| 6 | Integration layer, first slice (outbox, signed webhooks in both directions, secrets vault, durable worker, minimal admin UI) | **Implemented — awaiting review** |
| 7 | Hardening and Phase 6 follow-ups (RLS, DB role split, ledger protection, retention, rate limiting, ops) | Planned |
| 8 | Data exchange and adapters (REST API + API keys, CSV, scheduled sync, SQL connector, customer adapters) | Planned, customer-driven |

## Phase 1 — Foundation, tenancy, auth
Scaffold Next.js + TS + Tailwind + shadcn/ui + Prisma + Zod; `.env.example`, env validation; ESLint rules (restricted Prisma imports); test setup against a separate test database. Organization, User, Membership, Role; authentication; `TenantContext`; tenant-scoped repository pattern; `withTransaction`; composite-FK pattern proven with tests; first migration. **Exit:** cross-tenant isolation tests pass; app boots; empty org dashboard.

## Phase 2 — Warehouse structure + visual designer
PalletType, Warehouse, Rack, RackLevel, Bay, Position; capacity/validation domain logic; location-code generator/parser; floor plan view (zoom/pan/select/move/rotate/resize/save with versioning); rack elevation view; renderer: plain SVG. **Exit:** layout persists and reloads from DB; no layout hard-coded; an admin can model a real rack purely through data.

## Phase 3 — Catalog + inventory core
Product, ProductBarcode; InventoryBalance, InventoryMovement, receive/adjust/transfer, reservations (service level), constraints, immutability trigger, idempotency, reconciliation check, stock views by product/location. **Exit:** all tests in inventory.md pass including concurrency; no way to change stock without a movement.

## Phase 4 — Orders and picking
Orders/lines (manual entry), allocation policies, waves, pick tasks, picker screen with location/product verification. **Exit:** end-to-end order → picked, with concurrency tests on allocation. (Short picks and mobile/scanner UI are not done.)

## Phase 5 — Packing
Packing sessions, packages (integer grams/mm), package contents, the `packedQty ≤ pickedQty` invariant, order statuses PACKING/PACKED. Picking consumes stock; **packing never touches inventory** (this supersedes the Phase 0 sketch of staging positions and a `PACK` movement). **Exit:** order → packed with consistent inventory and movements. Not done: shipping, labels, carrier APIs, stations.

## Phase 6 — Integration layer (first slice)
Implemented: `Integration` records with a dedicated non-login service-user actor (grants limited to `products.manage` / `orders.manage`), an AES-256-GCM secrets vault with tenant-bound AAD and a write-only API, signed inbound webhooks (`POST /api/webhooks/{publicId}`, HMAC-SHA256, replay window, idempotent) with `product.upsert`, `order.create` and `order.cancel`, `ExternalRef` mapping, a transactional outbox (`order.created/allocated/picked/packed/cancelled`), outbound signed webhooks through an SSRF-safe HTTP client, a PostgreSQL-backed worker (`npm run worker`) with leases, backoff, DEAD state, replay, health and an outbound circuit breaker, retention of finished deliveries/events, an append-only `IntegrationLog`, a minimal admin UI and API, safe error logging (correlation ids, no raw messages) and a same-origin check for state-changing internal API calls. See [integrations.md](integrations.md).

## Phase 7 — Hardening and Phase 6 follow-ups
The exact remaining items (carried over from the Phase 6 design review and from the known limitations):

1. **Row-Level Security**: `SET LOCAL app.organization_id` in `withTransaction`, policies on the highest-risk tables (inventory, movements, orders, integrations, secrets). Design stays RLS-compatible.
2. **Database role split** (owner/migration role vs. application role) and **ledger protection**: the application role gets no `UPDATE`/`DELETE`/`TRUNCATE` on `InventoryMovement`, `InventoryOperation`, `PackingEvent`, `IntegrationLog`, `OutboxEvent` (row triggers do not stop `TRUNCATE` or a table owner; `resetDatabase` in tests needs a deliberate bypass).
3. **Movement CHECK evolution**: replace the hand-maintained `InventoryMovement_shape_check … ELSE false` with something that does not require rewriting a CHECK for every new movement type.
4. **History snapshots vs tenant-enforced FKs**: movements, pick tasks and reservation lines keep plain position ids; decide whether an archived-position table or RLS covers them.
5. **Authorization review for picking/packing**: per-user task assignment, segregation of duties, picker-only roles.
6. **Admin audit trail** (database table) for configuration and secret changes; today they go to the structured log stream only.
7. **Retention/partitioning**: `InboundEvent` payloads and `IntegrationLog` (currently kept forever), the movement table; data-minimization policy for inbound payloads.
8. **Rate limiting** for the webhook endpoint and the admin API; optional per-integration delivery concurrency and ordering.
9. **Secret operations**: vault key re-encryption tooling and a startup check that `INTEGRATION_ENCRYPTION_KEYS` is set in production (optionally a KMS-backed key).
10. **Operations**: worker supervision/deployment, metrics and alerts for DEAD events, paused integrations and queue age, backup/restore runbook, query/index review, reporting, final permissions and security review.

## Phase 8 — Data exchange and adapters (driven by real customers)
REST `/api/v1` with API keys (hashed, scoped), OpenAPI and `Idempotency-Key`; OAuth where a customer needs it; CSV import/export (import jobs with row-level reports reusing the inbound envelopes) and the generic `Job` table; scheduled sync (`SyncRun`, watermarks); an external SQL connector (read-only, named templates, timeouts, host allowlist); ERP / e-commerce / carrier adapters; `inventory.changed` events; inbound inventory adjustments and order updates; warehouse/location mapping and status-mapping tables; strict per-integration ordering; labels/printing and carrier shipping.

## Deferred / not planned yet
3D views, offline mobile, lot/serial/expiry tracking, handling units (LPN), multi-level bay variants, slotting optimization, returns/RMA, replenishment, cycle-count scheduling, carrier rate shopping.

## Finalized decisions

| Topic | Decision |
|---|---|
| ID strategy | **UUID** for all primary keys (PostgreSQL `uuid`, generated by the database or application consistently). |
| Authentication | **Auth.js**. |
| Level storage | `levelIndex` stored **0-based**, displayed **1-based** (ground level = `L01` in location codes). |
| Product / SKU | **Same entity** in v1 (variants deferred). |
| Row-Level Security | **Deferred** (Phase 7), but the architecture stays **RLS-compatible**: `organizationId` on every tenant-owned table, composite FKs, all queries through tenant-scoped repositories and a single transaction helper where `SET LOCAL app.organization_id` can later be added. |
| Testing | Automated tests use a separate **`warehouse_wms_test`** database, created by the developer and configured via its own environment variable. Never the development database. |

## Phase 1 implementation notes (deviations/clarifications)

- shadcn primitives live in `src/ui/primitives` (components.json aliases), matching the Phase 0 layout.
- Tenant resolution: `/[orgSlug]` routes call `resolveTenantContext(userId, slug)` on every request (layout + pages); no `proxy.ts`/middleware is used, so there is one enforcement point. Auth.js uses JWT sessions carrying only the user id.
- `modules/tenancy/repo/bootstrapRepo.ts` holds the few queries that must run before a TenantContext exists; everything else goes through `repo(ctx)` factories.
- Extra hand-written SQL migration adds CHECKs (lowercase email, slug format).
- No signup UI yet: organizations are created by `createOrganizationWithOwner` (seed/tests).
- Raw Prisma use is restricted by ESLint to repositories, `server/db`, seed and tests.

## Phase 2 implementation notes

Scope note: Phase 2 was requested as "Warehouse Designer" and therefore combines the structure and visual designer work of the Phase 0 plan. Products/catalog are NOT included and moved to Phase 3 with inventory.

- Renderer: **plain SVG** (no new dependency) for both the floor plan and the rack elevation; React Konva was not needed. The data contract (`LayoutDto`) is renderer-independent.
- Save model: the designer sends the complete desired layout (`PUT .../layout`) with the `layoutVersion` it loaded. Stale version -> 409. Missing items are deleted, new ids created, existing updated, and each rack's levels/bays/positions are reconciled in the same transaction.
- Bays are rack-wide columns (all levels share them). `Bay` stores `positionCount` and `palletTypeId`, applied to every level. Positions are derived: levels x bays x positionCount.
- Positions were initially **deleted** (not archived) when a structure shrinks or a rack is removed. `repo.removePositions` is the single choke point; Phase 3 made it refuse positions with stock or movement history.
- Known limitation: renaming two racks to each other's codes in one save (a swap) fails with a conflict; rename one at a time.
- Elevation levels are labelled 1-based in the UI (Level 1 = ground, code L01); stored levelIndex is 0-based.
- Permissions added: `warehouse.view`, `warehouse.design` (migration also updates existing built-in roles).
- The `Position.kind` (receiving/staging/...) from docs/database.md is deferred.

## Phase 3 implementation notes

Scope: products/SKUs, product barcodes, inventory balances, append-only movements, receive / move / adjust, reservation create/release, permissions, minimal UI (Products, Product detail, Inventory), tests. Not included: picking, packing, orders, integrations, CSV, scanning UI, labels, background jobs.

- **Concurrency**: guarded single-statement SQL, deterministic lock order, idempotency keys; proven by concurrency tests (20 parallel reservations for 5 units → exactly 5 succeed, opposite transfers do not deadlock, randomized storms keep the ledger equal to balances).
- **Position protection**: positions holding stock or reservations can no longer be removed by layout changes (409 `POSITION_IN_USE`, whole save rolls back). Empty positions behave as before.
- **UI**: location is entered as a location code and resolved server-side to a real Position id; operations carry an Idempotency-Key.
- **Permissions added**: `products.view`, `products.manage`, `inventory.view`, `inventory.adjust`, `inventory.reserve`.
- **One product per position** (added before the Phase 3 commit): enforced by a partial unique index on balances plus a service pre-check; see `docs/inventory.md`. The migration refuses to run if a position already holds several products (it changes no data).

## Phase 4 (picking) implementation notes

Scope: internal orders (manual entry), allocation/reservation through the inventory module, waves, pick tasks, pick confirmation with location/product/quantity verification, `PICK` movements, reservation consumption, permissions, UI (Orders, Order detail, Waves, Wave detail, Picker screen), tests. Not included: packing, shipping, integrations, CSV, scanner hardware/camera, labels, picker assignment, route optimization.

- **Architecture preserved**: UI → authenticated API → Zod → tenant context → picking service → inventory composition API → one transaction → PostgreSQL. Only the inventory module changes balances.
- **Behaviour choices**: partial allocation is explicit (`PARTIALLY_ALLOCATED`, unallocated quantity shown, tasks only for reserved stock, top-up by allocating again); nothing allocatable fails with `INSUFFICIENT_STOCK`; one reservation per position; order-managed reservations cannot be released from the inventory screen; cancelling a wave cancels its open tasks and releases their stock.
- **Movement CHECK updated** as flagged in Phase 3 (PICK added, unknown types rejected).
- **Dangerous operations to know**: `cancelWave` / `cancelOrder` release reservations (stock becomes allocatable again immediately); pick confirmation consumes stock irreversibly (undo = a new `ADJUSTMENT_IN`/`RECEIVE`, there is no un-pick); the position-deletion guard (Phase 3) protects positions with pending picks because reserved stock is > 0.
- **Lock order** (`Wave → Order → PickTask → Reservation → Balance`) is a rule for every new multi-row flow; see `docs/picking.md`.

## Phase 5 (packing) implementation notes

Scope: packing sessions, packages (integer grams / millimetres), package contents, picked-vs-packed invariant, order statuses PACKING/PACKED, permissions, UI (queue, session page), audit trail, generic idempotency, tests. Not included: shipping, labels, carrier APIs/rates, dimensional weight, package-type catalog, scanner hardware, packing stations.

- **Packing does not touch inventory.** This supersedes the Phase 0 sketch (staging position + `PACK` movement). Picking consumed the stock; packing records `pickedQty → package contents`. A test scans the packing module for any reference to inventory.
- **Invariant held in the database**: `OrderLine.packedQty` with CHECK `packedQty ≤ pickedQty` and guarded updates; partial unique index for one open session per order.
- **Partial picking**: packable for what is picked; the order stays PICKING and becomes PACKED only after every requested unit is picked and packed (documented in `docs/packing.md`).
- **Cancellation**: cancelling a session never reverses picking or inventory; refused once a package is completed (immutable). An order with an open session cannot be cancelled.
- **Lock order** extended: `Wave → Order → PackingSession → Package → PickTask → Reservation → Balance → OrderLine updates`.
- **Idempotency**: the generic `IdempotencyRecord` table is reusable.
- `PACKED` is the hand-off status; completed packages (number, weight g, dimensions mm, contents) are the shipment data, now published by the `order.packed` outbox event. There is no "reopen package" workflow, no labels, and no shipping status yet.

## Phase 6 (integrations) implementation notes

Scope: the items under "Phase 6" above. Not included: REST `/api/v1`, API keys, OAuth, CSV, external SQL, generic `Job` table, ERP/e-commerce/carrier adapters, `inventory.changed`, inbound inventory adjustments, warehouse/location mapping, status-mapping tables, strict ordering, rate limiting, RLS, DB role split.

- **Architecture preserved and extended** (called out per CLAUDE.md rule 3): a new `outbox` module is the only core dependency of the integration layer; `src/integrations/` is outside the core and imports only module public APIs. There is **no generic `Job` table** (the architecture sketch had one): `InboundEvent` and `IntegrationDelivery` carry their own state machines; a generic job table is deferred until scheduled sync/CSV need it.
- **Small core changes**: `createOrder` and the new `catalog.upsertProduct` accept an optional transaction; five `recordEvent` calls inside existing transactions (`createOrder`, `allocateOrder`, the last pick of `confirmPick`, `completePacking` when the order becomes PACKED, `cancelOrder`); `LockedOrder`/`lockOrder` also return `externalRef`; `identity.createIntegrationServiceUser`; two new permissions. `toErrorResponse` stopped logging raw 5xx messages; `tenantRoute` gained the same-origin check.
- **Actor model**: a dedicated non-login service user per integration (no nullable actor FKs). Grants are an allowlist of two permissions, enforced in code and by a CHECK.
- **Lock order**: `InboundEvent` / `IntegrationDelivery` rows come before the core order; core code never touches integration rows.
- **Decisions to confirm at review**: the inbound signing secret is generated in the browser and never returned by the server; `order.create` defaults to `READY`; `order.packed` is only published when the whole order is packed (not for a partial session). (Health is tracked separately per direction and only outbound failures drive the circuit breaker; migration `integration_health_split`.)

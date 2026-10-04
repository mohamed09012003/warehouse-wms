# CLAUDE.md — Permanent Development Rules

Multi-tenant Warehouse Management System. Stack: Next.js, TypeScript, PostgreSQL, Prisma, Tailwind CSS, shadcn/ui, Zod. Future warehouse editor: React Konva and/or SVG (2D only, no 3D). No MongoDB. No Docker for now.

Read `/docs` before changing architecture. Start with `docs/architecture.md` and `docs/roadmap.md`.

## Current phase

Phase 6 (integration layer, first slice) is implemented and awaiting review; Phases 0-5 are committed. **Do not begin the next phase until the user explicitly says so.** See `docs/roadmap.md` (the phase numbers there are the actual project phases).

Next.js 16 differs from older versions: read `AGENTS.md` and `node_modules/next/dist/docs/` before writing Next-specific code.

## Inventory rules (Phase 3)

- Only `modules/inventory` services change `InventoryBalance`, through the guarded SQL functions in `repo/inventoryRepo.ts`. Never read a quantity, compute a new one and write it back.
- Every quantity change writes `InventoryMovement` rows under an `InventoryOperation` in the same transaction. Movements and operations are append-only (database trigger); correct mistakes with a new operation.
- Positions holding stock or reservations must never be deleted; layout code removes positions only through `warehouseRepo.removePositions`.
- A position holds stock of ONE product at a time (partial unique index on `InventoryBalance(positionId) WHERE onHand > 0`; a different product gets `POSITION_OCCUPIED`). Never work around it; emptied positions are free again.
- Reserved stock is not movable/adjustable; operations consume *available* (onHand − reserved) stock only.
- Tests that touch inventory must run against the test database and may use `assertLedgerMatchesBalances` (tests/support/fixtures.ts).

## Picking rules (Phase 4)

- Orders and picking never change `InventoryBalance` or reservations directly. They use the inventory composition API (`runStockOperation` with `reservePlan` / `consume` / `releaseReservations`) so the stock change, its `InventoryMovement` rows and the picking updates commit in ONE transaction.
- Pick confirmation has a single code path (`confirmPick`) shared by the manual screen and any future scanner; it takes a location code, a SKU/barcode and a quantity, and verifies everything server-side.
- Multi-row picking flows lock in this order: Wave → Order → PickTask → Reservation → InventoryBalance → OrderLine updates; ascending id within a type. Do not invent a different order.
- Order-line quantities obey `requested ≥ allocated ≥ picked ≥ 0`; change them only through the guarded updates in `picking/repo`. Reservations created by allocation (`refType = ORDER_LINE`) are released only through the order/wave, never directly.
- New movement types or enum values need a migration that also updates the movement CHECK (it ends with `ELSE false`); enum values added by `ALTER TYPE … ADD VALUE` cannot be used in the same migration, so compare through `::text`.

## Packing rules (Phase 5)

- Packing NEVER touches inventory: the packing module must not read or write `InventoryBalance`, `InventoryMovement`, `InventoryOperation` or `Reservation` (a test enforces it). Picking consumes stock; packing records picked quantity → packages.
- `OrderLine.packedQty ≤ pickedQty` is the core invariant: change `packedQty` only through the guarded updates in `packing/repo` (CHECK constraint is the backstop). Picked quantity never decreases.
- Package and item changes lock Session → Package; session lifecycle changes lock Order → Session (full order: Wave → Order → PackingSession → Package → PickTask → Reservation → Balance → OrderLine). Completed packages and sessions are immutable; one OPEN session per order (partial unique index).
- All packing mutations go through `packingMutation` (one transaction, optional `Idempotency-Key` via `IdempotencyRecord`). Weight is integer grams, dimensions integer millimetres.

## Integration rules (Phase 6)

- **The core never imports `src/integrations/`** (ESLint rule + test). Core services publish domain events ONLY through `modules/outbox` `recordEvent(tx, ctx, event)`, inside the transaction of the business change: exactly one event per successful transition, none on rollback or idempotent replay. Core transactions never call external systems.
- Integrations reach the core only through module public APIs (`@/modules/<x>`), as a dedicated non-login service user whose permissions are an allowlist: `products.manage` and `orders.manage` only. **Never grant `inventory.*`, `warehouse.*`, `picking.manage` or `packing.manage`** to an integration; the integration layer never touches inventory, reservation, pick or packing tables (a test scans for it). Changing grants is Owner-only.
- **Secrets:** only in `IntegrationSecret` as AES-256-GCM ciphertext (AAD = organization + integration + name). `integrations/secrets/secretStore.ts` is the only code that reads that table or decrypts. Secrets are write-only through the API (metadata only on reads), never in `Integration.config`, logs, errors, `IntegrationLog`, events or the browser (a generated secret is shown once, client-side). Keys come from `INTEGRATION_ENCRYPTION_KEYS`; never commit them.
- **All outbound network I/O goes through `SafeHttpClient`** (https in production, every resolved address public, connection pinned, no redirects, timeouts, size cap). No `fetch`/`axios`/`node:http` anywhere else in `src/integrations`.
- Inbound: authenticate (HMAC signature, ±5 min), validate with Zod, **persist, return, process in the worker**: never run business logic inside the webhook request. Every inbound effect must be idempotent (event id + payload hash, `ExternalRef`, natural keys); permanent problems become `REJECTED`, transient ones retry with backoff, never retry forever.
- Worker rows are claimed with `FOR UPDATE SKIP LOCKED` and a lease; every transition out of `PROCESSING` is guarded by `(status, attempts)`. Lock order: integration work rows first, then the core order. `IntegrationLog` is append-only and holds only ids, codes and short redacted summaries: no payloads, headers, response bodies or credentials.
- Integration health is tracked **per direction** (`inbound*` / `outbound*` columns): inbound outcomes never touch outbound health, and only OUTBOUND failures can trip the circuit breaker (`outboundPausedAt`). Keep it that way.
- Do not log raw error messages (`toErrorResponse` logs code, class and correlation id only). State-changing `tenantRoute` calls are same-origin checked.
- Deferred, do not build without a new phase: REST `/api/v1`/API keys, OAuth, CSV, SQL connector, generic `Job` table, vendor adapters, `inventory.changed`, inbound inventory adjustments, rate limiting. See `docs/integrations.md`.

## Commands

- `npm run dev` / `build` / `start`; `npm run lint`; `npm run typecheck`
- `npm run worker` — integration worker loop (inbound processing, outbox fan-out, outbound delivery, retries); `npm run worker -- --once` for one pass. Needs `INTEGRATION_ENCRYPTION_KEYS`; uses whatever `DATABASE_URL` points at
- `npm run fake-erp` — development-only fake ERP (http://127.0.0.1:4100) for manual end-to-end testing of the integration layer; see `tools/fake-erp/README.md`. It must stay independent of the WMS (no WMS imports, no WMS database)
- `npm test` — vitest against `warehouse_wms_test` only (applies migrations to it first)
- `npm run db:migrate -- --name <name>` — `prisma migrate dev` after verifying DATABASE_URL is `warehouse_wms`
- `npm run db:migrate:test` — `migrate deploy` against the test database only
- `npm run db:seed` — fake demo org/user in the dev database (prints a random password once)
- Env: copy `.env.example` to `.env` (DATABASE_URL, TEST_DATABASE_URL, AUTH_SECRET; INTEGRATION_ENCRYPTION_KEYS to use integrations)

## Rules

1. **Keep solutions simple.** Choose the simplest design that satisfies the requirement and the documented invariants.
2. **Avoid unnecessary dependencies.** Justify every new package; prefer the platform, Prisma, Zod and shadcn/ui first.
3. **Do not silently change architecture.** Any change to the documented architecture requires updating the relevant `/docs` file in the same change and calling it out to the user.
4. **Do not hard-code warehouse structures.** Layouts, racks, levels, bays and positions come from database configuration.
5. **Do not hard-code pallet types.** They are per-organization data (`PalletType`), in millimeters.
6. **Do not hard-code location counts.** Bay/position counts are derived from or validated against physical configuration.
7. **Never put secrets in source code, docs, tests, fixtures or commits.**
8. **Use environment variables** (`DATABASE_URL`, etc.) for secrets and configuration. Provide `.env.example` with placeholders only; `.env*` (except the example) stays git-ignored. Validate env with Zod at startup.
9. **Schema changes only via Prisma migrations** (`prisma migrate dev` / `migrate deploy`). Never `db push` against anything but a throwaway database. Never edit an applied migration. Constraints Prisma can't express (CHECKs, partial indexes, RLS) go in hand-written SQL inside the migration.
10. **Critical inventory operations run in PostgreSQL transactions** with the concurrency rules in `docs/inventory.md`.
11. **Maintain inventory auditability.** Every quantity change writes an append-only `InventoryMovement` in the same transaction. Never update balances outside the inventory service. Never update/delete movements.
12. **Business logic is separate from UI.** React components and route handlers/server actions call module services; they contain no business rules and no direct Prisma calls.
13. **Write tests for critical inventory logic** (no negative stock, no double reservation, concurrency, movement-per-change, tenant isolation). Run against a real PostgreSQL test database, not mocks.
14. **Design integrations to be extensible.** Core domain never imports from `integrations/`; adapters depend on core ports, not the reverse. Never couple to a customer's ERP schema.
15. **Maintain multi-tenant isolation.** Every tenant-owned table has `organizationId`; every query goes through the tenant-scoped data layer; cross-tenant references are blocked by composite foreign keys. `organizationId` comes from the authenticated session, never from client input.
16. **Do not move to the next development phase automatically.** Stop at the end of each phase and wait for review.
17. **Each phase is implemented, tested, reviewed and committed separately.**

## Testing database

**Never use the development database for automated tests.** Tests run only against the separate `warehouse_wms_test` database (own env var, e.g. `TEST_DATABASE_URL`). Test setup must refuse to run if the connection points at any other database.

## Finalized decisions

UUID ids; Auth.js; levels stored 0-based and displayed 1-based; Product and SKU are one entity in v1; RLS deferred but the design stays RLS-compatible; separate test database. See `docs/roadmap.md`.

## Conventions

- Dimensions: integer millimeters (`...Mm`). Weights: integer grams (`...G`). Never strings with units.
- Quantities: integers in the product's base unit.
- Timestamps: `timestamptz`, UTC. Money is not in scope unless a phase says so.
- IDs: UUIDs; never expose or parse as meaning. Business identifiers (codes) are separate unique-per-scope fields.
- Validate all external input with Zod at the boundary (API, server actions, imports, webhooks). Domain code receives validated types.
- Prefer deleting data by soft-delete/archival (`archivedAt`) for entities referenced by history (products, locations, racks).
- Folder layout: see `docs/architecture.md#folder-structure`. Domain modules live in `src/modules/<domain>`; dependency direction is `ui → service → domain/repo`, never reverse.
- Commit style: one logical change per commit; phase boundaries get their own commit.

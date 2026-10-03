# Architecture

## Goals and constraints

- Production-grade multi-tenant WMS; PostgreSQL is the WMS source of truth.
- Stack: Next.js (App Router), TypeScript, PostgreSQL, Prisma, Tailwind, shadcn/ui, Zod. Editor later: React Konva and/or SVG.
- 2D only. No Docker yet; PostgreSQL runs locally (database `warehouse_wms` already exists; do not recreate). Credentials only via `DATABASE_URL` in an untracked `.env`.

## Style: modular monolith

One Next.js deployable, organized as **domain modules** with strict layering. No microservices, no event bus, no CQRS framework. Complexity is added only where the domain demands it (inventory correctness, tenant isolation, integrations).

```
 UI (React components, pages)
        │ calls
 API layer (route handlers, server actions)  ── validates with Zod, resolves tenant context
        │ calls
 Module services (use cases / application logic, transactions)
        │ uses
 Domain (pure functions: rules, calculations, code generation)   Repositories (Prisma, tenant-scoped)
        │
 PostgreSQL
```

Rules: UI never touches Prisma or business rules. Domain code is pure (no I/O) and trivially unit-testable. Services own transaction boundaries. Modules talk to each other only through each other's public `index.ts` service API, never through each other's tables directly (exception: foreign keys).

## Modules (bounded contexts)

| Module | Responsibility |
|---|---|
| `tenancy` | Organizations, memberships, roles/permissions, tenant context |
| `identity` | Users, authentication/session |
| `catalog` | Products, barcodes, units, pallet types |
| `warehouse` | Warehouses, floor-plan objects, racks, levels, bays, positions, location codes |
| `inventory` | Balances, movements, reservations, adjustments, transfers (the correctness core) |
| `orders` | Orders and order lines (WMS-side representation) |
| `picking` | Waves, allocation, pick tasks, short picks |
| `packing` | Packing sessions, packages, labels |
| `integrations` | Adapters, webhooks, import/export, sync (outside the core; depends on core ports) |

Dependency direction: `integrations → (all)`; `packing → picking → inventory → warehouse/catalog → tenancy`. Lower modules never import higher ones.

## Multi-tenancy (summary; details in database.md)

Defense in depth, three layers:

1. **Schema**: every tenant-owned table has `organizationId NOT NULL`. Child tables reference parents with **composite foreign keys** `(organizationId, parentId)`, so a row physically cannot point at another tenant's parent.
2. **Application**: a `TenantContext { organizationId, userId, permissions }` is derived from the session in one place (`server/auth`). All repositories are constructed *from* the context (`repo(ctx)`) and inject `organizationId` into every `where`/`create`. Raw `prisma` is only importable inside `server/db` and repositories (enforced by lint rule `no-restricted-imports`). Client input never supplies `organizationId`.
3. **Database (phase-gated hardening)**: PostgreSQL Row-Level Security with `SET LOCAL app.organization_id` per transaction on the highest-risk tables (inventory, movements, orders). Introduced once the data layer is stable; policies live in migrations. Cross-tenant tests are mandatory.

Users are global identities; access is via `Membership(user, organization, role)`, so one person can serve multiple organizations. Integration API keys and webhooks are bound to a single organization.

## Authorization

Roles are per-organization and map to a code-defined list of permission strings (e.g. `inventory.adjust`, `warehouse.design`, `picking.execute`). Permission names are fixed in code (they gate code paths); role→permission assignments are data. Checks happen in services, not only in UI.

## Cross-cutting concerns

- **Validation**: Zod schemas per module in `schemas/`; shared between forms, API and imports. Domain types are inferred from them where sensible.
- **Errors**: typed domain errors (`InsufficientStockError`, `LocationOccupiedError`, …) mapped to HTTP/UI responses at the API layer only.
- **Transactions**: `withTransaction(ctx, fn)` helper wraps Prisma `$transaction`, sets tenant session variable, and retries on serialization/deadlock errors (see inventory.md).
- **Config**: `server/env.ts` parses `process.env` with Zod; the app fails fast on missing config.
- **Audit**: inventory movements are the audit ledger for stock. A general `AuditLog` (who changed config like racks/roles) is added for non-inventory entities when needed.
- **Eventing**: a transactional **outbox** table (`OutboxEvent`) records domain events (e.g. `inventory.changed`, `order.shipped`) in the same transaction as the change. A worker later dispatches them to webhooks/integrations. No message broker initially.
- **Background work**: needed for webhooks, scheduled sync, imports. Initially a simple DB-backed job runner (`Job` table, `FOR UPDATE SKIP LOCKED`) triggered by a separate Node process or cron-hit route; no new infra. Revisit only if load requires.
- **Observability**: structured logging with request id + organizationId. No PII or secrets in logs.

## Folder structure

```
warehouse-wms/
├─ CLAUDE.md
├─ docs/
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/             # includes hand-written SQL for CHECKs/partial indexes/RLS
│  └─ seed.ts                 # dev-only demo data; no secrets
├─ src/
│  ├─ app/                    # Next.js routes ONLY: thin pages, layouts, route handlers
│  │  ├─ (auth)/
│  │  ├─ (app)/[orgSlug]/     # tenant-scoped UI routes
│  │  │   ├─ warehouses/ ├─ products/ ├─ inventory/ ├─ orders/ ├─ picking/ ├─ packing/ └─ settings/
│  │  ├─ pick/                # mobile picking PWA-style routes (later)
│  │  └─ api/
│  │      ├─ v1/              # public REST API (API-key/OAuth auth), versioned
│  │      ├─ internal/        # session-authed endpoints for the app
│  │      └─ webhooks/        # inbound webhooks from external systems
│  ├─ ui/                     # presentation only
│  │  ├─ primitives/          # shadcn/ui components (generated)
│  │  ├─ shared/              # tables, forms, layout
│  │  └─ features/            # warehouse-designer/, rack-elevation/, picking-mobile/ ...
│  ├─ modules/                # business logic, one folder per bounded context
│  │  └─ <module>/            # tenancy, identity, catalog, warehouse, inventory, orders, picking, packing
│  │      ├─ domain/          # pure logic + types (no Prisma, no React)
│  │      ├─ service/         # use cases, transactions, permission checks
│  │      ├─ repo/            # Prisma access, tenant-scoped
│  │      ├─ schemas/         # Zod
│  │      ├─ __tests__/
│  │      └─ index.ts         # the module's public API
│  ├─ integrations/           # outside the core
│  │  ├─ core/                # ports, adapter registry, mapping, sync runner, outbox dispatcher
│  │  ├─ rest/                # REST API helpers (auth, pagination, idempotency)
│  │  ├─ webhooks/            # signing, delivery, retry
│  │  ├─ csv/                 # import/export
│  │  └─ adapters/            # erp-*/ecommerce-*/sql-* (added per customer need)
│  ├─ server/                 # infrastructure shared by modules
│  │  ├─ db/                  # Prisma client, withTransaction, tenant session
│  │  ├─ auth/                # session, tenant context
│  │  ├─ env.ts
│  │  └─ logging/
│  └─ lib/                    # tiny framework-free utilities (units, ids, dates)
├─ tests/                     # integration/e2e tests needing the real database
└─ .env.example               # placeholders only
```

Note: the user's requested separation maps as — UI: `ui/` + `app/`; application logic: `modules/*/service`; database: `prisma/` + `server/db` + `modules/*/repo`; validation: `modules/*/schemas`; API: `app/api` + `integrations/rest`; integrations: `integrations/`; domains: `modules/{warehouse,inventory,picking,packing}`.

## Key decisions (ADR summary)

| # | Decision | Why |
|---|---|---|
| 1 | Modular monolith | Simplest thing that gives clear boundaries; one deploy, one DB, real transactions across inventory+picking |
| 2 | Composite FKs for tenancy | Makes cross-tenant references impossible at the DB level, not just by convention |
| 3 | Structured location + stored generated code | Fast lookup/scanning by code, but structure remains the truth |
| 4 | Positions are real rows | Inventory needs a stable FK target; layout edits must not orphan stock |
| 5 | Balance table + append-only movement ledger | Fast reads and strict audit; balance is derived-verifiable from the ledger |
| 6 | Conditional-UPDATE concurrency (no app locks) | Atomic, simple, scales; see inventory.md |
| 7 | Layout stored as relational + numeric geometry | The designer renders from DB; no layout in code |
| 8 | Integration layer behind ports + outbox | Core never couples to customer systems; reliable event delivery |
| 9 | Prisma + hand-written SQL for constraints | Prisma lacks CHECK/partial index/RLS support; migrations remain the single schema history |
| 10 | Integer mm / grams / base-unit quantities | No float drift; unambiguous units |

## Major risks and mitigations

| Risk | Mitigation |
|---|---|
| Tenant data leak | Composite FKs, tenant-scoped repos, import restrictions, RLS hardening, mandatory cross-tenant tests |
| Negative/oversold stock, races | CHECK constraints, atomic conditional updates, row locks in deterministic order, retries, concurrency tests |
| Untraceable stock changes | Single inventory service; movement written in same transaction; no UPDATE/DELETE on movements |
| Layout edits corrupt inventory | Positions are archived not deleted; layout changes validated against occupied positions |
| Layout/capacity inconsistency | Capacity derived/validated from physical config in domain code, covered by unit tests |
| Prisma limitations (CHECK, RLS, `FOR UPDATE`) | Documented raw SQL escape hatch in `server/db`, wrapped and tested |
| Integration coupling/brittleness | Ports/adapters, external ID mapping table, idempotent inbound ops, outbox for outbound |
| Scope creep / over-engineering | Phased roadmap, simplicity rule, each phase reviewed before the next |
| Mobile scanning latency/offline | Scan validation is single small API calls; offline support explicitly deferred, noted as risk |
| Large floor plans slow in browser | Layout loaded per warehouse as simple JSON; Konva layers/virtualization if needed |

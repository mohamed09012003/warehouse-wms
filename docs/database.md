# Database

PostgreSQL via Prisma. Database `warehouse_wms` exists and is empty. Connection only via `DATABASE_URL` (untracked `.env`; `.env.example` holds placeholders). All schema changes are Prisma migrations; Postgres features Prisma can't express are hand-written SQL inside those migrations.

> This is a **design**, not a schema. Field lists are indicative; Phase 1+ finalizes them. Not every entity needs to exist on day one — each phase creates only its tables.

## Conventions

- PKs: `id String @id` (cuid2 or uuid; pick one in Phase 1, use everywhere).
- Every tenant-owned table: `organizationId` NOT NULL, indexed, first column of most composite indexes.
- `createdAt`, `updatedAt` (`timestamptz`); `archivedAt` for soft-archive where history references the row.
- Units: `...Mm` Int, `...G` Int (grams), quantities Int. Money out of scope.
- Enums via Prisma enums for closed sets (movement types, order status); data-driven sets (pallet types, roles, zone kinds if user-extensible) are tables.
- Business codes (`sku`, rack `code`, location `code`) are unique **within their scope**, never globally.

## Tenant isolation pattern

Every tenant-owned parent gets `@@unique([organizationId, id])`. Children reference parents with composite FKs:

```prisma
model Rack {
  id             String @id
  organizationId String
  warehouseId    String
  code           String
  warehouse Warehouse @relation(fields: [organizationId, warehouseId], references: [organizationId, id])
  @@unique([organizationId, id])
  @@unique([warehouseId, code])
}
```

Result: a Rack of org A cannot reference a Warehouse of org B even with a buggy query. Costs one extra unique index per parent; acceptable. RLS is layered on later (see architecture.md).

## Entities

(`*` = unique/index highlights. `org` = organizationId.)

### Tenancy / identity
| Table | Key fields | Constraints / indexes |
|---|---|---|
| Organization | id, slug, name, settings Json | unique(slug) |
| User | id, email, passwordHash/externalAuthId, name | unique(email) — *global, not tenant-owned* |
| Role | id, org, name, permissions String[] | unique(org, name) |
| Membership | id, org, userId, roleId, status | unique(org, userId); index(userId) |
| ApiKey | id, org, name, keyHash, prefix, scopes, lastUsedAt, revokedAt | unique(prefix); only hash stored |

### Catalog
| Table | Key fields | Constraints / indexes |
|---|---|---|
| Product | id, org, sku, name, baseUnit, weightG?, lengthMm?, widthMm?, heightMm?, archivedAt | unique(org, sku); index(org, name) |
| ProductBarcode | id, org, productId, barcode, packQty (default 1), kind | **unique(org, barcode)**; FK (org, productId) |
| PalletType | id, org, name, widthMm, lengthMm, heightMm?, maxLoadG?, archivedAt | unique(org, name); CHECK dims > 0 |

### Warehouse
| Table | Key fields | Constraints / indexes |
|---|---|---|
| Warehouse | id, org, code, name, widthMm, lengthMm (canvas), timezone, address Json | unique(org, code) |
| WarehouseObject | id, org, warehouseId, type, label, xMm, yMm, widthMm, depthMm, rotationDeg, zIndex, props Json | index(warehouseId); `type` enum (WALL, DOOR, AISLE, LOADING_AREA, PACKING_AREA, WORK_AREA, ZONE, OTHER); CHECK dims > 0 |
| Rack | id, org, warehouseId, code, name?, xMm, yMm, rotationDeg, lengthMm, depthMm, heightMm, bayWidthDefaultMm?, archivedAt | unique(warehouseId, code); CHECK dims > 0; rotation 0–359 |
| RackLevel | id, org, rackId, levelIndex, elevationMm, clearanceMm, maxLoadG?, defaultPalletTypeId? | unique(rackId, levelIndex); CHECK elevation ≥ 0, clearance > 0; levels must fit rack height (domain) |
| Bay | id, org, rackId, bayIndex, offsetMm, widthMm | unique(rackId, bayIndex); sum of widths ≤ rack length (domain-validated); bays are rack-wide (all levels share bay columns) |
| Position | id, org, warehouseId, rackId?, levelId?, bayId?, positionIndex, kind, code, palletTypeId?, maxLoadG?, archivedAt | **unique(warehouseId, code)**; unique(bayId, levelId, positionIndex) where rack-based; index(org, warehouseId, kind) |

`Position.kind`: `STORAGE`, `RECEIVING`, `STAGING`, `PACKING`, `SHIPPING`, `ADJUSTMENT`/virtual. Non-storage kinds may have no rack/level/bay (`rackId/levelId/bayId` NULL; CHECK enforces "all three set or none; STORAGE requires all three"). This ensures stock always has a legitimate location.

A `Position` row stores denormalized structure numbers? **No** — structure comes from FKs (`rack.code`, `level.levelIndex`, `bay.bayIndex`, `positionIndex`). `code` is a *generated, stored* convenience column, regenerated transactionally on renumbering (see warehouse-model.md). Unique code + FKs both exist.

### Inventory
| Table | Key fields | Constraints / indexes |
|---|---|---|
| InventoryBalance | id, org, warehouseId, positionId, productId, onHand, reserved, (lotId? later), version, updatedAt | **unique(org, positionId, productId[, lotId])**; **CHECK onHand ≥ 0 AND reserved ≥ 0 AND reserved ≤ onHand**; index(org, productId); index(positionId) |
| InventoryMovement | id, org, warehouseId, productId, type, qtyDelta, reservedDelta, fromPositionId?, toPositionId?, onHandAfter, reservedAfter, reason, refType, refId, idempotencyKey?, actorUserId?, actorApiKeyId?, createdAt | **append-only** (trigger forbids UPDATE/DELETE); unique(org, idempotencyKey) partial where not null; index(org, productId, createdAt); index(org, positionId, createdAt); index(refType, refId) |
| Reservation | id, org, orderId?, waveId?, status, createdAt, expiresAt? | index(org, status) |
| ReservationLine | id, org, reservationId, productId, positionId (balance key), qty, pickedQty | unique(reservationId, positionId, productId); CHECK qty > 0 |

### Orders / picking / packing
| Table | Key fields | Constraints / indexes |
|---|---|---|
| Order | id, org, warehouseId, number, status, externalRef?, customer snapshot Json, priority, shipTo Json | unique(org, number); index(org, status); unique(org, source, externalId) where external |
| OrderLine | id, org, orderId, productId, qtyOrdered, qtyAllocated, qtyPicked, qtyPacked, qtyShort | unique(orderId, lineNo); CHECK counters ≥ 0 and consistent |
| PickingWave | id, org, warehouseId, number, status, releasedAt | unique(org, number) |
| WaveOrder | waveId, orderId (join) | PK(waveId, orderId); an order is in at most one active wave (partial unique) |
| PickTask | id, org, waveId, orderLineId?, productId, fromPositionId, toPositionId (staging/cart), qtyPlanned, qtyPicked, status, assignedToUserId?, sequence | index(org, assignedToUserId, status); index(waveId, sequence) |
| PackingStation | id, org, warehouseId, name, positionId? | unique(warehouseId, name) |
| PackingSession | id, org, orderId, stationId, packerUserId, status, startedAt, closedAt | partial unique: one OPEN session per order |
| Package | id, org, sessionId, number, weightG?, lengthMm?, widthMm?, heightMm?, status, carrier?, trackingNo? | unique(org, number) |
| PackageItem | id, org, packageId, orderLineId, productId, qty | CHECK qty > 0 |
| Label | id, org, packageId, format, payload/blobRef, createdAt | |

### Integrations / platform
`Integration`, `IntegrationCredential` (encrypted blob + key id), `ExternalRef(org, integrationId, entityType, internalId, externalId)` unique(org, integrationId, entityType, externalId), `WebhookEndpoint`, `WebhookDelivery`, `ImportJob`, `SyncRun`, `OutboxEvent`, `Job`, `AuditLog`. See integrations.md.

## Constraints that need hand-written SQL

Prisma cannot declare these; they go in migration SQL files and are covered by tests:

- CHECK constraints (balance non-negativity, dimension positivity, kind/structure consistency).
- Partial unique indexes (idempotency keys, one OPEN session per order, one active wave per order).
- Trigger blocking UPDATE/DELETE on `InventoryMovement`.
- RLS policies and `FORCE ROW LEVEL SECURITY` (hardening phase).
- Optional: deferred trigger asserting rack bay widths ≤ rack length (or enforce in domain only; decide in Phase 2).

## Indexing guidance

- Lead with `organizationId` in composite indexes for list/filter queries; the composite-FK unique indexes already start with it.
- Hot paths: balance lookup by (position, product); stock by product across positions; movements by product/position over time; open pick tasks by assignee; orders by status; barcode lookup by (org, barcode); location lookup by (warehouse, code).
- Don't add speculative indexes; add them when a query plan demands it (`EXPLAIN` in review).
- Movements will be the largest table: BRIN or partitioning by month (`createdAt`) is a later option, so keep `createdAt` in indexes and avoid FKs that would make partitioning hard (movement→balance is by value keys, not an FK).

## Migrations and environments

- `prisma migrate dev` locally; `migrate deploy` elsewhere. Never edit applied migrations; fix forward.
- Separate databases for dev and test (e.g. `warehouse_wms_test`), created by the developer; tests reset it. Never run tests against the dev DB.
- Seed script is dev-only, contains fake data only.

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

## Implemented in Phase 3

Tables: `Product`, `ProductBarcode`, `InventoryBalance`, `InventoryOperation`, `InventoryMovement`, `Reservation`, `ReservationLine`; enums `InventoryMovementType` (RECEIVE, MOVE, ADJUSTMENT_IN, ADJUSTMENT_OUT, RESERVE, RELEASE) and `ReservationStatus` (ACTIVE, RELEASED). Migration `catalog_inventory`.

Differences from the design above:
- **SKU** is stored uppercase and CHECKed against `^[A-Z0-9][A-Z0-9._/-]{0,63}$`; it is immutable through the application. `ProductBarcode` has no `packQty` yet; barcodes are unique per organization, 1–128 characters, trimmed.
- **`InventoryOperation`** (new) holds the idempotency key (`unique(organizationId, idempotencyKey)`; NULLs never collide) and groups movement rows. The partial-unique-index idea was unnecessary.
- **`InventoryMovement`** stores `positionId` / `counterpartPositionId` as plain ids with code snapshots (no FK to Position); one row per balance change; CHECK enforces the sign pattern per type and valid after-snapshots. `UPDATE`/`DELETE` on movements and operations raise an exception (trigger `inventory_ledger_is_append_only`).
- **`InventoryBalance`** has composite FKs to `Position(organizationId, warehouseId, id)` (new unique) and `Product`, both RESTRICT; CHECK `onHand >= 0 AND reserved >= 0 AND reserved <= onHand AND onHand <= 1000000000`.
- **`Reservation`/`ReservationLine`**: line positions are plain ids + code snapshots; `quantity > 0` CHECK.
- The migration also adds the new permission names to the existing built-in roles.

### Single-product position occupancy (migration `single_product_per_position`)

```sql
CREATE UNIQUE INDEX "InventoryBalance_one_product_per_position_idx"
  ON "InventoryBalance" ("positionId") WHERE "onHand" > 0;
```

Hand-written because Prisma cannot model partial indexes; `schema.prisma` is unchanged and `prisma migrate diff` reports no drift. A DO block at the top of the migration aborts with a descriptive error (no data is changed) if existing rows already violate the rule. The unique violation (23505) naming this index is mapped to `POSITION_OCCUPIED` in `normalizeError`. See `docs/inventory.md`.

## Implemented in Phase 4 (migration `orders_picking`)

Tables: `Order`, `OrderLine`, `PickingWave`, `PickTask`; enums `OrderStatus` (DRAFT, READY, PARTIALLY_ALLOCATED, ALLOCATED, PICKING, PICKED, CANCELLED), `WaveStatus` (DRAFT, RELEASED, IN_PROGRESS, COMPLETED, CANCELLED), `PickTaskStatus` (PENDING, IN_PROGRESS, COMPLETED, CANCELLED). New enum values: `InventoryMovementType.PICK`, `ReservationStatus.CONSUMED`. New columns: `ReservationLine.consumedQuantity`, `Reservation.consumedAt`; new unique `ReservationLine(organizationId, id)`.

- **Tenancy**: every table has `organizationId`; all references are composite FKs `(organizationId, id)` (order→lines, line→product, task→order / order line / wave / product / reservation / reservation line). A task cannot reference another organization's record (tests attempt each reference).
- **`Order`**: `unique(organizationId, orderNumber)` (uppercase, CHECK `^[A-Z0-9][A-Z0-9._/-]{0,39}$`); `externalRef` is not unique. Index `(organizationId, status)`, `(organizationId, createdAt)`.
- **`OrderLine`**: `unique(orderId, lineNo)`, `unique(orderId, productId)`; CHECK `lineNo >= 1 AND requestedQty > 0 AND requestedQty <= 100000000 AND pickedQty >= 0 AND pickedQty <= allocatedQty AND allocatedQty <= requestedQty`.
- **`PickingWave`**: `unique(organizationId, number)` (per-organization sequence, retried on collision); lifecycle timestamps.
- **`PickTask`**: `positionId` is a plain id plus `positionCode` snapshot (no FK, like movements and reservation lines); `unique(organizationId, reservationLineId)` (a reservation line backs at most one task); CHECK `quantity > 0 AND 0 <= pickedQty <= quantity` and status consistency (`COMPLETED ⇒ pickedQty = quantity`, `PENDING ⇒ pickedQty = 0`). Indexes: `(organizationId, status)`, `(organizationId, waveId)`, `orderId`, `orderLineId`, `(organizationId, productId)`, `positionId`.
- **`InventoryMovement_shape_check`** replaced (adds PICK, `ELSE false`). **`ReservationLine_consumed_check`**: `0 <= consumedQuantity <= quantity`.
- **Enum values in one migration**: `ALTER TYPE … ADD VALUE` cannot be *used* in the same transaction, so the new constraints compare enum columns through `::text` and never mention PICK/CONSUMED as enum literals; application code uses them only after the migration commits.
- The migration adds `orders.view/manage` and `picking.view/manage` to the existing built-in roles (nothing is removed).

## Implemented in Phase 5 (migration `packing`)

Tables: `PackingSession`, `Package`, `PackageItem`, `PackingEvent`, `IdempotencyRecord`; enums `PackingSessionStatus`, `PackageStatus` (OPEN, COMPLETED, CANCELLED), `PackingEventType`. `OrderStatus` gains `PACKING` and `PACKED`; `OrderLine` gains `packedQty`. None of these tables references any inventory table.

- **Tenancy**: every table has `organizationId`; all references are composite FKs. `Package(organizationId, sessionId, orderId)` → `PackingSession(organizationId, id, orderId)` (a package's order is its session's order); `PackageItem(organizationId, packageId, orderId)` → `Package(organizationId, id, orderId)` and `PackageItem(organizationId, orderId, orderLineId, productId)` → `OrderLine(organizationId, orderId, id, productId)` (the line belongs to the same order and the product is the line's product). New uniques on `OrderLine`: `(organizationId, orderId, id, productId)`.
- **One open session per order**: `CREATE UNIQUE INDEX "PackingSession_one_open_per_order_idx" ON "PackingSession" ("orderId") WHERE "status" = 'OPEN'`.
- **Core invariant**: `CHECK ("packedQty" >= 0 AND "packedQty" <= "pickedQty")` on `OrderLine` (the cross-row sum is held by the guarded `packedQty` counter).
- **Package**: `unique(orderId, packageNumber)`; CHECK positive integer measures when present (`weightG`, `lengthMm`, `widthMm`, `heightMm`), dimensions all-or-none, `packageType` ≤ 40 chars; `COMPLETED ⇒ completedAt`, `CANCELLED ⇒ cancelledAt`. **PackageItem**: `unique(packageId, orderLineId)`, CHECK `0 < quantity <= 100000000`. **PackingSession**: status/timestamp CHECK.
- **PackingEvent**: append-only (trigger `PackingEvent_append_only`). **IdempotencyRecord**: `unique(organizationId, scope, key)`, generic and reusable.
- Indexes: package/session by status and session, items by order line and product, sessions by order.
- The migration adds `packing.view`/`packing.manage` to the built-in roles (nothing removed). `ALTER TYPE … ADD VALUE` for the new order statuses is not used in the same migration.

# Domain Model

Conceptual model. Table-level detail is in `database.md`. Every entity below except `User` is owned by exactly one **Organization**.

## Overview

```
Organization ─┬─ Membership ── User            (users are global; membership gives role in an org)
              ├─ Role
              ├─ PalletType
              ├─ Product ── ProductBarcode
              ├─ Warehouse ─┬─ WarehouseObject   (walls, doors, zones, aisles … floor-plan items)
              │             └─ Rack ── RackLevel ── Bay ── Position (= storage location)
              ├─ InventoryBalance (product × position [× lot]) ── InventoryMovement (ledger)
              ├─ Reservation ── ReservationLine
              ├─ Order ── OrderLine
              ├─ PickingWave ── PickTask
              ├─ PackingSession ── Package ── PackageItem
              └─ Integration ── (credentials, mappings, webhook endpoints, sync runs, jobs)
```

## Entities

### Tenancy and identity
- **Organization** — the tenant. Has slug, name, settings (default units, locale, location-code format).
- **User** — a person with a login. Global.
- **Membership** — user ↔ organization with a Role; status (active/invited/disabled).
- **Role** — per-organization set of permission strings (see architecture.md).

### Catalog
- **Product** — a stockable item identified by a unique-per-org `sku`. Design decision: the request lists "Product" and "SKU"; in v1 these are the **same entity** (a product row *is* a SKU). Variants/kits can be layered later (`parentProductId` or `ProductVariant`) without changing inventory, since inventory references the SKU-level row. Holds name, base unit, optional weight/dimensions (mm/g), tracking flags (lot/serial — deferred), default pallet type hints.
- **ProductBarcode** — many barcodes per product (EAN/UPC/internal/QR), unique per org, optional pack quantity (a case barcode = 12 units).
- **PalletType** — organization-defined: name, `widthMm`, `lengthMm`, optional `heightMm`, `maxLoadKg`/grams, active flag. Never hard-coded.

### Warehouse (see warehouse-model.md)
- **Warehouse** — physical site with floor-plan canvas dimensions (mm), timezone, address.
- **WarehouseObject** — any floor-plan item that is not storage: wall, door, aisle, loading area, packing area, work area, custom. Geometry + type + label.
- **Rack** — a storage structure placed on the floor plan (x, y, rotation, `lengthMm`, `depthMm`, `heightMm`) with a code (e.g. `R01`).
- **RackLevel** — a horizontal tier (index 0 = ground), height of the beam above floor, clearance, max load, default pallet types.
- **Bay** — a vertical section of the rack along its length; own `widthMm`, ordered, so bays may differ in width.
- **Position** — the smallest addressable storage slot (one pallet/tote/bin place) within a bay on a level. **A Position is the storage location** used by inventory. Has structured identifiers plus generated `code`.

### Inventory (see inventory.md)
- **InventoryBalance** — current quantity of a product at a position: `onHand`, `reserved`; `available = onHand − reserved`.
- **InventoryMovement** — immutable ledger entry for every quantity change.
- **Reservation / ReservationLine** — a claim on specific balances for an order or wave. Prevents double allocation.
- **Special positions** — receiving, staging, packing and "pick-cart" locations are Positions flagged by `kind` (not racks necessarily; they can live in zones), so that stock is never "nowhere".

### Orders / picking / packing
- **Order / OrderLine** — WMS-side outbound order (created manually, by import, or by integration). Holds an external reference for mapping.
- **PickingWave** — a batch of orders released together; drives allocation and task generation.
- **PickTask** — instruction to move N of product P from position A to a staging/cart position, assigned to a picker, with verification and short-pick outcome.
- **PackingSession** — a packer at a packing station working one order (or consolidation).
- **Package / PackageItem** — a physical parcel and the quantities of products in it, with weight/dimensions and label data.

### Integrations (see integrations.md)
- **Integration** — a configured connection to an external system (type, status, encrypted credentials ref).
- Supporting: `ExternalRef` (internal ID ↔ external ID), `WebhookEndpoint`/`WebhookDelivery`, `ImportJob`, `SyncRun`, `ApiKey`, `OutboxEvent`, `Job`.

## Lifecycles

- **Order**: `DRAFT → OPEN → ALLOCATED → IN_PICKING → PICKED → PACKING → PACKED → SHIPPED`, plus `CANCELLED`, `BACKORDER`/partial states. Transitions are domain functions; illegal transitions throw.
- **PickingWave**: `PLANNED → RELEASED → IN_PROGRESS → COMPLETED | CANCELLED`.
- **PickTask**: `PENDING → ASSIGNED → IN_PROGRESS → DONE | SHORT | CANCELLED`.
- **PackingSession**: `OPEN → CLOSED | ABORTED`; **Package**: `OPEN → CLOSED → LABELED → SHIPPED`.

## Core invariants (domain-level)

1. `onHand ≥ 0`, `0 ≤ reserved ≤ onHand` for every balance.
2. Every change to `onHand`/`reserved` has a movement in the same transaction.
3. An entity never references an entity of another organization.
4. A position belongs to exactly one bay/level/rack (or one special zone) for life; layout edits never delete positions that have stock or history — they archive them.
5. Position dimensions must fit within bay width × rack depth × level clearance (validated in domain code).
6. Location codes are unique per warehouse.
7. A barcode resolves to at most one product per organization.

## Implemented in Phase 3

`Product` (= SKU in v1; active/disabled, never deleted), `ProductBarcode`, `InventoryBalance`, `InventoryMovement` (with an `InventoryOperation` header), `Reservation` / `ReservationLine`. Lifecycles: Reservation ACTIVE → RELEASED. Orders, picking and packing entities are still design-only. Invariant 2 ("every change has a movement in the same transaction") and the stock invariants above are enforced by the inventory service plus database CHECKs; invariant 4 is now enforced for stock-holding positions (see `docs/inventory.md`).

## Implemented in Phase 4

`Order` / `OrderLine`, `PickingWave`, `PickTask`. Lifecycles (full detail and diagrams in `docs/picking.md`):
- **Order**: DRAFT → READY → PARTIALLY_ALLOCATED / ALLOCATED → PICKING → PICKED, or CANCELLED. Derived from line quantities after every allocation, pick, release and cancel.
- **Wave**: DRAFT → RELEASED → IN_PROGRESS → COMPLETED, or CANCELLED.
- **PickTask**: PENDING → IN_PROGRESS → COMPLETED, or CANCELLED.
- **Reservation** gains CONSUMED (all lines consumed by picking); a task is backed by exactly one reservation line. Packing, shipping and order integrations are still design-only.
Invariants added: `requested ≥ allocated ≥ picked ≥ 0` per order line; `0 ≤ pickedQty ≤ quantity` per task; stock leaves the ledger only through a `PICK` movement tied to a reservation.

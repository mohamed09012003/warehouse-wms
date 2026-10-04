# Packing

Implemented in Phase 5 (awaiting review): packing sessions, packages, package contents. Not implemented: shipping, carrier APIs/rates, labels, dimensional weight, package-type catalog, packing stations, barcode hardware/camera scanning.

```
Picked order ─start─▶ PackingSession (OPEN) ─▶ Package(s) OPEN ─▶ add picked items ─▶ complete package ─▶ complete session ─▶ order PACKED
```

> **Phase 0 design superseded.** The original design had packing issue a `PACK` inventory movement from a staging position. The implemented model is simpler and stricter: **picking consumes stock (Phase 4); packing never touches inventory.** There is no staging position and no `PACK` movement. Packing records only which *picked* quantities were placed in which packages.

Module: `src/modules/packing` (domain `progress.ts`, repo, schemas, services `sessions` / `packages` / `items` / `queries`, `mutation` helper). The module does not import the inventory module and never reads or writes `InventoryBalance`, `InventoryMovement`, `InventoryOperation` or `Reservation`; a test scans the source to keep it that way.

## The central invariant

For every order line: **`packedQty ≤ pickedQty ≤ allocatedQty ≤ requestedQty`**.

- `OrderLine.packedQty` counts the quantity currently placed in **open or completed** packages (cancelled packages do not count). It is changed only by guarded single-statement updates inside the packing transaction: `packedQty + q <= pickedQty` to add, `packedQty - q >= 0` to give back. Concurrent additions therefore can never exceed what was picked.
- The database backstops it: `CHECK ("packedQty" >= 0 AND "packedQty" <= "pickedQty")`.
- `packedQty` always equals the sum of `PackageItem.quantity` over the line's non-cancelled packages (asserted by the test helper `assertPackingInvariants`).

Example: picked 10. Package 1 = 6 and Package 2 = 4 is fine; Package 2 = 5 is rejected (`PACK_QUANTITY_EXCEEDED`, 422: "Only 4 of SKU picked but not yet packed").

## Packing session

```
OPEN ──complete──▶ COMPLETED          OPEN ──cancel──▶ CANCELLED
```

- **One OPEN session per order**: enforced by a partial unique index (`PackingSession_one_open_per_order_idx … WHERE status = 'OPEN'`) and by the service (the order row is locked first, so two simultaneous starts serialize and the second is refused).
- **Start** (`startPacking`, `packing.manage`): the order must be `PICKING` or `PICKED`, must have picked quantity, and must have picked-but-unpacked quantity. Rejected: nothing picked, `CANCELLED`, `PACKED`, an order that already has an open session, everything picked already packed. A fully picked order (`PICKED`) becomes `PACKING`; a partially picked order keeps its status.
- **Complete** (`completePacking`): requires every package closed (no OPEN package), **all picked quantity packed** (`packed = picked` on every line, something picked) and at least one completed package. If every *requested* unit is picked and packed the order becomes `PACKED`; otherwise it stays `PICKING` (see below).
- **Cancel** (`cancelPacking`): allowed only while the session has **no completed package** (completed packages are immutable). Its OPEN packages are cancelled (quantities become unpacked again, package rows kept as history), the session becomes `CANCELLED`, and a `PACKING` order returns to `PICKED`. **It never restores inventory, never undoes picking and never writes a movement.** The order is immediately available for a new session.
- A completed or cancelled session cannot be modified.

## Order status integration

The existing Phase 4 status model gained two values, `PACKING` and `PACKED`:

```
… PICKING ─all lines picked─▶ PICKED ─start packing─▶ PACKING ─every requested unit packed─▶ PACKED (final)
                                         ▲                 │
                                         └──cancel session─┘
```

- `PACKING` exists only while a packing session is open on a **fully picked** order.
- **Partially picked orders** (requested > picked) can be packed for what was picked: the session works the same, but the order's status stays `PICKING` (it is never reported as packed). After that session completes there is nothing left to pack until more is picked ("Everything picked so far has already been packed"); when the rest is picked and allocated the order becomes `PICKED`, a new session packs the remainder, and only then is the order `PACKED`. If the last units are picked while a session is open, the order becomes `PACKING` directly.
- A package existing never makes an order packed; completing the session with everything requested picked and packed does.
- A cancelled order cannot be packed. An order with an open packing session cannot be cancelled (cancel or complete the session first); `PACKING` and `PACKED` orders are not cancellable.
- Picking flows never overwrite `PACKING`/`PACKED`.

## Package

```
OPEN ──complete──▶ COMPLETED (immutable)          OPEN ──cancel──▶ CANCELLED
```

- Numbered `1, 2, 3 …` **per order** (continues across sessions; cancelled packages keep their number); `unique(orderId, packageNumber)`.
- Optional `packageType` (free text ≤ 40), `weightG`, `lengthMm`, `widthMm`, `heightMm`: **integers**, grams / millimetres, positive when given; the three dimensions come together or not at all. Enforced in Zod and by a CHECK. No dimensional-weight or rates.
- `completePackage` requires at least one item; afterwards the package is immutable: add, edit, remove, update details, cancel and complete all fail with `INVALID_STATE`. `completedAt` and the completing user are recorded.
- Details can be changed while OPEN (`updatePackage`).

## Package contents

`PackageItem(package, order, order line, product, quantity)`, one row per (package, order line); adding the same line again increases the quantity. Composite foreign keys make it impossible to put a line of another order, or a product that is not the line's product, in a package. Quantity is a positive integer (CHECK).

- **Add** (`addPackageItem`): `productCode` (SKU or barcode — exactly what a scanner sends) + `quantity`, optional `orderLineId`. The product must be on the order and match the line.
- **Change quantity** (`setPackageItemQuantity`, ≥ 1) and **remove** (`removePackageItem`): only while the package and session are OPEN. Corrections change only package-content records and `packedQty`; **no inventory movement is ever written**.
- Real `Product`/`OrderLine` ids are authoritative; SKU/name come from the product relation.

## Audit trail

`PackingEvent` is an append-only log (trigger rejects UPDATE/DELETE) of every action: session started/completed/cancelled, package created/updated/completed/cancelled, item added/changed/removed (with quantity delta and result), plus the actor.

## Concurrency and idempotency

- **Lock order**: `Wave → Order → PackingSession → Package → PickTask → Reservation → Balance → OrderLine updates` (packing uses a subsequence). Session lifecycle changes (start/complete/cancel) lock Order then Session; package and item changes lock Session then Package. Every package/item operation locks the session first, so all changes inside one session are serialized; picking confirmations lock the order, so picked quantities cannot change underneath a completion.
- **Guarded updates** for `packedQty`; CHECK as backstop; partial unique index for the open-session rule.
- Two users starting packing → one session. Two additions racing for the same remaining quantity → exactly the available quantity is packed. Two completions of one package or one session → one succeeds, the other gets `INVALID_STATE`.
- **Idempotency**: optional `Idempotency-Key` (header or body) on every mutation. The key's `IdempotencyRecord` (`unique(organizationId, scope, key)`) is inserted in the same transaction as the work: a repeat with the same request returns the current state with `replayed: true` without redoing anything; the same key with a different request is a conflict; if the work fails the record rolls back so the key stays usable. The picker UI sends a fresh key per click.

## Permissions

`packing.view` (queue, sessions) and `packing.manage` (start/complete/cancel sessions, packages, contents). Owner and Admin have both; Member has `packing.view` only.

## UI

`/packing` — the queue: orders with picked quantity (partially picked ones included) with requested / picked / packed / remaining / package count and **Start packing** (or Continue / the reason it is blocked). `/packing/{session}` — progress and per-line table, create package (type, weight g, dimensions mm), per-package cards (contents, add item, edit quantity, remove, save details, complete, cancel), **Complete packing** / **Cancel packing**. The orders list and order page show packed quantities and link to packing.

## Not done / known limitations

- No shipping, labels, carrier integration, tracking numbers, package-type catalog or packing stations.
- A cancelled session with completed packages is not possible (completed packages are immutable); there is no "reopen package" workflow yet.
- No per-user packing assignment; any user with `packing.manage` can work any session.
- Weight is optional and unchecked against product weights.

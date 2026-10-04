# Inventory

The correctness core. Products are independent of locations; stock is the relation *product × position*.

## Data model

- **InventoryBalance(org, positionId, productId[, lotId])**: `onHand`, `reserved`. `available = onHand − reserved` (computed, never stored, so it can't drift).
- **InventoryMovement**: immutable ledger of every change.
- **Reservation / ReservationLine**: claims on specific balances (position + product) for an order/wave.

Quantities are integers in the product's base unit. Fractional units (kg, litres) are out of scope; if needed later, use a fixed scale (e.g. milli-units) rather than floats.

A product may have balances in many positions. A balance row exists only while needed (zero rows may be kept or cleaned up by a job; either is valid—reads treat missing as 0).

## Invariants

0. **One product per position.** A Position holds stock of one product at a time (see "Single-product occupancy" below).

1. `onHand ≥ 0`
2. `0 ≤ reserved ≤ onHand`
3. Every change to `onHand` or `reserved` writes exactly one movement row in the **same transaction**.
4. Movements are immutable (DB trigger blocks UPDATE/DELETE). Corrections are new movements.
5. `balance.onHand == Σ movement.qtyDelta` per (position, product) — verifiable by a reconciliation job/test.
6. A reservation line's quantity is always backed by `reserved` on its balance; releasing/consuming a reservation adjusts both together.

Invariants 1–2 are enforced by **CHECK constraints**, so even a buggy code path fails rather than corrupting data.

## Operations (single module API: `modules/inventory/service`)

All are the only code allowed to write balances. Each runs in one transaction, takes `ctx` (tenant + actor), accepts an optional `idempotencyKey`.

| Operation | Effect | Movement type |
|---|---|---|
| `receive` | +onHand at position | RECEIVE |
| `adjust` | ±onHand (count correction), reason required | ADJUSTMENT_IN / ADJUSTMENT_OUT |
| `move` | −onHand at A, +onHand at B (atomic) | MOVE (two rows sharing one operation) |
| `reserve` | +reserved on chosen balances | RESERVE |
| `releaseReservation` | −reserved | RELEASE |
| `pick` (consume reservation by moving to staging) | −onHand/−reserved at source, +onHand at staging | PICK |
| `packConsume` | −onHand at staging (partial allowed) | PACK |
| `ship` / `issue` | −onHand final | ISSUE |
| `scrap` | −onHand | SCRAP |

Movement row: type, `qtyDelta`, `reservedDelta`, from/to position, `onHandAfter`, `reservedAfter` (snapshots make audit and debugging trivial), reason, reference (`refType`, `refId` e.g. order/pick task), actor (user or API key), `idempotencyKey`, timestamp.

## Concurrency strategy

Principle: **let the database enforce correctness atomically; keep application locking minimal and deterministic.**

1. **Atomic conditional updates** (primary mechanism). Example reserve:
   ```sql
   UPDATE "InventoryBalance"
      SET reserved = reserved + $qty, version = version + 1
    WHERE "organizationId" = $org AND id = $id
      AND onHand - reserved >= $qty;
   -- 0 rows affected ⇒ InsufficientAvailableStockError (no read-then-write gap)
   ```
   Decrements likewise guard in the `WHERE` (`onHand >= $qty`). Prisma: `updateMany` with guarded `where` or `$executeRaw`; the affected-row count decides success. Plain read-modify-write in application code is **forbidden** for balances.
2. **Upsert for first receipt**: `INSERT … ON CONFLICT (org, positionId, productId) DO UPDATE SET onHand = onHand + $qty` — safe under concurrent first receipts.
3. **Deterministic lock ordering** for multi-row operations (transfers, multi-line reservations): sort affected balance keys (positionId, productId) and update in that order, so two transactions never lock in opposite orders ⇒ no deadlocks from ordering.
4. **Isolation level**: default READ COMMITTED is sufficient because correctness lives in guarded single-statement updates and CHECKs. Use `SERIALIZABLE` only for specific read-then-decide algorithms (e.g. allocation planning), with retry.
5. **Retry**: `withTransaction` retries on serialization failure (`40001`) and deadlock (`40P01`) with bounded attempts + jitter. Operations are idempotent via keys so retries and client re-sends are safe.
6. **Allocation (choosing which balances)**: planning reads candidate balances (ordered by policy, e.g. FEFO/FIFO/closest), then attempts guarded reservations; if a guarded update fails because someone else won, re-plan (bounded loop). Optionally `SELECT … FOR UPDATE SKIP LOCKED` on candidate balances in the allocator so concurrent waves skip contended rows instead of waiting.
7. **Double reservation**: impossible by construction — reservations are increments of `reserved` guarded by `onHand − reserved ≥ qty`. A unique(reservationId, positionId, productId) prevents duplicate lines; idempotency keys prevent replay.
8. **Idempotency**: `unique(org, idempotencyKey)` on movements (partial). Replay returns the original result. Required for API/integration callers and mobile retries.
9. **Optimistic `version`** column on balances for UI-driven edits (e.g. count adjustment confirms "I counted against version N"); not the main safety net.
10. **Never** hold a transaction open across user interaction or external calls. Integration calls happen via outbox after commit.

## Reservations

- Created by allocation (picking phase) for an order or wave; each line targets a specific balance (position+product) so pick tasks know exactly where to go.
- Lifecycle: ACTIVE → CONSUMED (picked) | RELEASED (cancelled/short) | EXPIRED (optional TTL job).
- Short pick: pick task completes with qty < planned; the remainder is released (RELEASE) and the order line records `qtyShort`; optional re-allocation from another position.
- Availability reads (`available` by product, by warehouse) aggregate balances; for hot products a periodic or trigger-maintained summary can be added later—do not add speculatively.

## Reconciliation and integrity

- A test and an admin-run job verify `Σ movements == onHand` and `reserved == Σ active reservation lines`; discrepancies are surfaced, never auto-"fixed" silently.
- Cycle counts produce ADJUSTMENT movements with reason `CYCLE_COUNT` and the counter's identity.

## Pallet/handling-unit note

v1 tracks quantities per position, not individual pallets/LPNs. If customers need license-plate tracking, add `HandlingUnit` between position and balance later; the movement ledger and constraints stay valid. Lot/expiry/serial tracking likewise extends the balance key (`lotId`) without changing the model.

## Required tests (Phase 3 gate)

Run against a real PostgreSQL test database:
- cannot go negative (adjust, pick, transfer, scrap);
- N concurrent reserves for the last unit → exactly one succeeds;
- concurrent transfers in opposite directions don't deadlock/corrupt;
- each operation writes exactly the expected movement(s); failed operations write none (rollback);
- idempotency replay returns the same result, no double effect;
- Σ movements equals balance after randomized operation sequences;
- tenant isolation: org A cannot read/modify org B balances or reference its products/positions.

## Implementation status (Phase 3)

Implemented in `src/modules/inventory` (operations) and `src/modules/catalog` (products, barcodes). Only what is listed here exists; picking, packing, pick/pack movement types and background jobs do not.

**Operations** (`service/operations.ts`): `receiveStock`, `moveStock`, `adjustStock`, `createReservation`, `releaseReservation`. Movement types in use: `RECEIVE`, `MOVE`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `RESERVE`, `RELEASE`. Names in the table above that are not implemented yet (PICK, PACK, ISSUE, SCRAP) are reserved for later phases and will be added to the enum by migration.

**Ledger shape.** `InventoryOperation` is a header (type, actor, reason, `idempotencyKey`, `requestHash`, ref). `InventoryMovement` has one row per balance change: `positionId` + `positionCode` snapshot, optional counterpart position (for MOVE), `qtyDelta`, `reservedDelta`, `onHandAfter`, `reservedAfter`. A MOVE writes two rows (source negative, destination positive) under one operation. Both tables are append-only (database trigger rejects UPDATE/DELETE). Movements reference positions by plain id plus code snapshot, with no foreign key, so history stays readable when a layout changes.

**Balances.** `InventoryBalance(organizationId, positionId, productId)` is unique, with composite foreign keys to `Position(organizationId, warehouseId, id)` (RESTRICT) and `Product`. CHECKs: `onHand >= 0`, `reserved >= 0`, `reserved <= onHand`, `onHand <= 1,000,000,000`. Per-operation quantity limit is 100,000,000.

**Concurrency, as implemented.** Balances change only through four single-statement guarded SQL functions in `repo/inventoryRepo.ts`: `receiveInto` (`INSERT ... ON CONFLICT DO UPDATE`), `takeOut`, `reserve` (both `WHERE onHand - reserved >= qty`) and `unreserve` (`WHERE reserved >= qty`), each `RETURNING` the new quantities. No read-modify-write. Multi-row operations touch rows in a deterministic order (MOVE: lower position id first; reservations: sorted by position then product). `withTransaction` retries serialization/deadlock failures (including those reported through raw queries). Default READ COMMITTED is used.

**Idempotency.** An optional `idempotencyKey` (body or `Idempotency-Key` header) is unique per organization. Same key + same request returns the original result with `replayed: true`; same key + different request is a conflict; concurrent identical requests are applied once.

**Reservations.** `Reservation` (ACTIVE | RELEASED) with `ReservationLine` (product, position id + code snapshot, quantity). Creation is all-or-nothing across lines. Release flips ACTIVE→RELEASED in one guarded statement (a reservation can be released once), then unreserves each line. Reserved stock can be neither moved nor adjusted away: moves and decreases consume only *available* stock. CONSUMED and expiry are not implemented (they arrive with picking).

**Rules enforced by the services** (all server-side, Zod-validated): products and positions must belong to the caller's organization (foreign ids are reported as "not found"); increasing operations require an active product; MOVE requires both positions in the same warehouse; adjustments require a reason; a decrease can never cut into reserved stock.

**Permissions:** `inventory.view`, `inventory.adjust` (receive, move, adjust), `inventory.reserve` (create/release reservations), `products.view`, `products.manage`.

**Layout safety.** Positions with `onHand > 0` or `reserved > 0` cannot be removed by a layout change: `warehouseRepo.removePositions` throws `PositionInUseError` (HTTP 409, message lists the codes) and the whole save rolls back. Empty (0/0) balance rows are cleaned up so empty positions stay removable. The RESTRICT foreign key is the backstop. Archiving positions is not implemented; occupied positions are protected by rejection instead.

**Known limitations:** no lots/serials/expiry; no per-pallet (LPN) tracking; no cross-warehouse transfers; no reconciliation job (only the test helper `assertLedgerMatchesBalances`); no partial release of a reservation; stock counts are not paginated beyond 500 rows.

### Single-product occupancy

**Rule.** A physical Position may hold stock (`onHand > 0`) for only ONE product at a time. More of the same product is always allowed. When a position's stock reaches zero it is empty and any product may be placed there; no assignment is remembered.

**Enforcement.**
- *Database (authoritative):* the partial unique index `InventoryBalance_one_product_per_position_idx ON "InventoryBalance" ("positionId") WHERE "onHand" > 0`. At most one balance row per position can be positive. Two requests racing to put different products on the same empty position cannot both commit: the second gets a unique violation (SQLSTATE 23505), which the application reports as `POSITION_OCCUPIED` (HTTP 409, `PositionOccupiedError`). Rows with `onHand = 0` are ignored, so zero rows are harmless and not an assignment (they are not cleaned up eagerly; stock lists hide them).
- *Service (clear message):* receive, move (destination) and adjust-increase first look up the position's current occupant inside the operation's transaction and reject a different product with a message naming the occupying SKU. This check only improves the message; it is not what makes the rule safe.
- *Reservations:* `reserved <= onHand` means a position with reserved stock always has `onHand > 0`, so it stays with its product, and reserved stock cannot be moved or adjusted away to free the position. Creating a reservation requires existing stock of that product at the position, so it can never create occupancy.
- *Every route:* the rule lives in the shared guarded SQL (`receiveInto`) and the index, not in any one endpoint; receive, move and adjust-increase are the only operations that can add stock to a position.

**Concurrency note.** Writers that add stock to a position (`receiveInto`: receive, move destination, adjust-increase) take a transaction-scoped advisory lock per position (`pg_advisory_xact_lock`). This is needed for correctness, not just speed: `INSERT ... ON CONFLICT` only arbitrates one unique index, so without the lock two concurrent first receipts of the SAME product could trip the partial index and be rejected with a false `POSITION_OCCUPIED` (found by the concurrency tests). With the lock a same-product writer always sees the committed row and a different-product writer always sees the real occupant; the partial unique index remains the backstop for any writer that bypasses the function. Positions are always touched in ascending id order, so the advisory lock sits at the same level as that position's row lock and adds no deadlock cycle (deadlocks are retried anyway).

**Existing data.** The migration `single_product_per_position` refuses to run (with a readable message listing the positions) if any position already holds more than one product. It never modifies or deletes data: move the extra products to other positions, then apply it again.

## Implementation status (Phase 4): picking support

**New movement type `PICK`.** Consumes reserved stock: `onHand` and `reserved` both decrease by the same amount (`qtyDelta < 0` and `reservedDelta = qtyDelta`). The migration `orders_picking` replaced the movement shape CHECK: it now covers PICK and ends with `ELSE false`, so an unknown type is rejected instead of silently passing. The append-only triggers are unchanged. The movement types are now RECEIVE, MOVE, ADJUSTMENT_IN, ADJUSTMENT_OUT, RESERVE, RELEASE, PICK.

**Reservation lifecycle.** `Reservation.status`: `ACTIVE` → `RELEASED` (outstanding quantity released) or → `CONSUMED` (every line fully consumed by picking). Records are never deleted. `ReservationLine.consumedQuantity` (CHECK `0 ≤ consumed ≤ quantity`) tracks consumption; the **outstanding** reserved quantity of a line is `quantity − consumedQuantity`. Releasing a reservation (manually or by cancel) releases only the outstanding part. `Reservation.consumedAt` records when it closed. Picking creates **one reservation per position** (`refType = ORDER_LINE`); reservations with that `refType` cannot be released through the inventory API (the order owns them).

**Composition API for other modules** (`runStockOperation`, no permission check, no HTTP route): lets picking run its own work and the stock changes in ONE transaction, under one `InventoryOperation`, with the usual idempotency:
- `availableStock(productId)` — positions with available stock in physical order (rack, level, bay, position);
- `reservePlan(...)` — reserve up to the planned quantity per position (guarded `reserveUpTo`: the balance row is locked inside the statement and `LEAST(planned, available)` is taken), one reservation per position that yielded stock;
- `consume({ reservationLineId, quantity })` — locks the reservation, increases the line's consumed quantity (guarded), decreases `onHand` and `reserved` (guarded: `reserved >= q AND onHand >= q`), closes the reservation when fully consumed, writes the `PICK` movement; failures throw `RESERVATION_UNAVAILABLE`;
- `releaseReservations(ids)` — locks reservations (ascending id), releases outstanding quantities (balances in ascending position order), writes `RELEASE` movements.

Only the inventory module touches `InventoryBalance`; picking supplies the domain updates (tasks, order lines, statuses) as a callback that runs inside the same transaction. On an idempotent replay the callback is not run again.

**Concurrency.** Lock order across modules: `Wave → Order → PickTask → Reservation → InventoryBalance → OrderLine updates` (see `docs/picking.md`). Standalone inventory operations lock `Reservation → Balance` / balances by position id, a suffix of that order, so they cannot deadlock with picking.

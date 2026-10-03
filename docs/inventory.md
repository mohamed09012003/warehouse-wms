# Inventory

The correctness core. Products are independent of locations; stock is the relation *product × position*.

## Data model

- **InventoryBalance(org, positionId, productId[, lotId])**: `onHand`, `reserved`. `available = onHand − reserved` (computed, never stored, so it can't drift).
- **InventoryMovement**: immutable ledger of every change.
- **Reservation / ReservationLine**: claims on specific balances (position + product) for an order/wave.

Quantities are integers in the product's base unit. Fractional units (kg, litres) are out of scope; if needed later, use a fixed scale (e.g. milli-units) rather than floats.

A product may have balances in many positions. A balance row exists only while needed (zero rows may be kept or cleaned up by a job; either is valid—reads treat missing as 0).

## Invariants

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
| `receive` | +onHand at position | RECEIPT |
| `adjust` | ±onHand (count correction), reason required | ADJUSTMENT |
| `transfer` | −onHand at A, +onHand at B (atomic) | TRANSFER (two linked rows, or one with from/to) |
| `reserve` | +reserved on chosen balances | RESERVE |
| `releaseReservation` | −reserved | UNRESERVE |
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
- Short pick: pick task completes with qty < planned; the remainder is released (UNRESERVE) and the order line records `qtyShort`; optional re-allocation from another position.
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

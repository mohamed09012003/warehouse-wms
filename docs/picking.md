# Picking

Implemented in Phase 4 (awaiting review): internal orders, allocation, waves, pick tasks and pick confirmation. Not implemented: packing, shipping, ERP/e-commerce order import, barcode scanning hardware/camera, label printing, route optimization, task assignment to individual pickers.

```
Order ─ready─▶ Allocate (reserve stock via inventory) ─▶ Pick tasks ─▶ Wave ─release─▶ start ─▶ Picker confirms ─▶ stock consumed ─▶ PICKED
```

Modules: `src/modules/orders` (order entry, lifecycle helpers, reads) and `src/modules/picking` (allocation, waves, tasks, confirmation). **Stock is never changed in these modules.** They call the inventory module's composition API (`runStockOperation` → `reservePlan`, `consume`, `releaseReservations`), so a pick and its stock change commit in one transaction while only the inventory module touches `InventoryBalance`.

## Order lifecycle

```
DRAFT ─ready─▶ READY ─allocate─▶ PARTIALLY_ALLOCATED ─allocate again─▶ ALLOCATED
                 │                      │  ╲_____________________________↗
                 │                      └─first pick─▶ PICKING ─all lines fully picked─▶ PICKED (final)
                 └─────────cancel (any status before PICKED)─────────▶ CANCELLED (final)
```

| Status | Meaning |
|---|---|
| `DRAFT` | Entered, not yet released for allocation. |
| `READY` | May be allocated (nothing reserved). Also the state after releasing an allocation. |
| `PARTIALLY_ALLOCATED` | Some, but not all, of the requested quantity is reserved. Shown as "Partially allocated". |
| `ALLOCATED` | Every line is fully reserved. |
| `PICKING` | At least one unit has been picked. |
| `PICKED` | Every line is fully picked (picked = requested). Final. |
| `CANCELLED` | Cancelled; remaining reservations released; already picked stock stays consumed. Final. |

The status after any allocation/pick/release/cancel step is **derived from the line quantities** (`deriveFulfilmentStatus`): all lines fully picked → PICKED; anything picked → PICKING; everything allocated → ALLOCATED; something allocated → PARTIALLY_ALLOCATED; else READY. A partially allocated order whose allocated stock is all picked stays `PICKING` (never `PICKED`) until the rest is allocated and picked.

**Order lines.** `requestedQty ≥ allocatedQty ≥ pickedQty ≥ 0` (database CHECK, and guarded updates in code). `allocatedQty` = quantity reserved for the line and not released; the outstanding reservation is `allocatedQty − pickedQty`. One line per product per order. Order numbers are normalized to uppercase and unique per organization.

## Allocation

`allocateOrder` (permission `picking.manage`), allowed for `READY`, `PARTIALLY_ALLOCATED` and `PICKING` orders:

1. Lock the order.
2. For each line with unallocated quantity, find positions holding **available** stock (`onHand − reserved > 0`) of the product, in stable physical order: rack code, level, bay, position. Because of the one-product-per-position rule, such a position never holds another product.
3. Plan greedily (`planAllocation`): take from the first position first, never more than it has available, until the need is met. Example: A has 5 at `R01-L01-B01-P01` and 7 at `R01-L01-B02-P01`; an order for 8 gets 5 + 3.
4. Reserve through the inventory module (`reserveUpTo`: one statement locks the balance row and takes `LEAST(planned, available)`, so the amount is exact under concurrency). **One reservation per position** (`refType = ORDER_LINE`, `refId = order line id`), each backed by one `RESERVE` movement.
5. Create one pick task per reservation, in `PENDING` with no wave.
6. Increase the line's `allocatedQty`, derive the order status.

**Partial allocation.** If stock is short, as much as possible is allocated; the shortfall stays unallocated (`unallocatedQty` is shown) and the order is `PARTIALLY_ALLOCATED` — never reported as fully allocated. Tasks exist only for stock that was actually reserved. Allocating again later (stock received, other reservations released) tops up the remainder with new reservations and tasks; this also works while the order is `PICKING`. If **nothing** can be allocated the request fails with `INSUFFICIENT_STOCK` and changes nothing. A fully allocated order cannot be allocated again.

**Release allocation** (`releaseOrderAllocation`, `PARTIALLY_ALLOCATED`/`ALLOCATED` before any pick): cancels the order's open tasks, releases their reservations through inventory (history kept; reservations become `RELEASED`), sets `allocatedQty` back, order returns to `READY`. Refused if any task sits in a RELEASED/IN_PROGRESS wave (cancel the wave first) or picking has started.

**Cancel order** (`cancelOrder`, permission `orders.manage`, any status before PICKED/CANCELLED): same as release, plus the order becomes `CANCELLED`. Quantity already picked stays consumed (`allocatedQty` is reduced to `pickedQty`). A wave left with no open task is completed.

Reservations created by allocation are **owned by picking**: the inventory screen/API refuses to release them directly (`CONFLICT`); release the order's allocation instead.

## Waves

```
DRAFT ─release─▶ RELEASED ─start─▶ IN_PROGRESS ─all tasks done─▶ COMPLETED
  └──────────────cancel (DRAFT / RELEASED / IN_PROGRESS)──────────▶ CANCELLED
```

- `createWave` → `DRAFT`, numbered per organization (shown `W-0001`).
- `addOrdersToWave` (DRAFT only): adds the **unassigned `PENDING` tasks** of orders that are `PARTIALLY_ALLOCATED`, `ALLOCATED` or `PICKING`. An order with no such task is rejected.
- `releaseWave` needs at least one task; `startWave` lets pickers confirm picks.
- `completeWave` requires no open task. A wave also completes **automatically** when the last open task of an `IN_PROGRESS` wave finishes (or is cancelled).
- `cancelWave`: open tasks are cancelled, their reservations released through inventory, line `allocatedQty` reduced, and each affected order's status re-derived (e.g. back to `READY`/`ALLOCATED`/`PICKING`). Picked quantity stays consumed.

## Pick tasks

A task picks `quantity` of one product from one position for one order line. `positionId` is the authoritative location (a plain id, like movements and reservation lines, so history survives layout changes) with `positionCode` as a snapshot. A task is backed by exactly one reservation line (`reservationLineId`, unique).

`PENDING` (nothing picked) → `IN_PROGRESS` (partly picked) → `COMPLETED` (fully picked); `CANCELLED` from `PENDING`/`IN_PROGRESS` (picked quantity kept). Database CHECKs: `0 ≤ pickedQty ≤ quantity`; `COMPLETED ⇒ pickedQty = quantity`; `PENDING ⇒ pickedQty = 0`.

## Pick confirmation

`confirmPick` (permission `picking.manage`) — one operation, one HTTP endpoint (`POST …/picking/tasks/{id}/confirm`), used by the manual screen today and by a scanner later. The body carries exactly what a scanner reads:

```json
{ "locationCode": "R01-L01-B01-P01", "productCode": "SOLAR-A or a barcode", "quantity": 2 }
```
plus an optional `Idempotency-Key` header.

Checks, in order (all server-side):
1. The task exists in the caller's organization (else `NOT_FOUND`).
2. The location code resolves, within the task's warehouse, to the task's **exact Position** (`WRONG_LOCATION`, 422).
3. The product code (SKU, any case, or any barcode of the organization) resolves to the task's product (`WRONG_PRODUCT`, 422).
4. Quantity is a positive integer (`VALIDATION_FAILED`).
Then, **inside the transaction** after locking: the task is `PENDING`/`IN_PROGRESS` (`TASK_NOT_PICKABLE`: completed / cancelled), it is in an `IN_PROGRESS` wave, the order is pickable; quantity ≤ remaining on the task and on the order line (`PICK_QUANTITY_EXCEEDED`, 422); and the reservation still holds the stock (`RESERVATION_UNAVAILABLE`, 409).

On success, atomically: the reservation line's `consumedQuantity` increases (reservation becomes `CONSUMED` when fully consumed), `onHand` **and** `reserved` decrease, one `PICK` movement is written, the task's `pickedQty`/status, the order line's `pickedQty`, the order status and the wave status are updated. Any failure rolls everything back.

## Concurrency and idempotency

- **Lock order** (every multi-row flow follows it, so flows cannot deadlock each other): `Wave → Order → PickTask → Reservation → InventoryBalance → OrderLine updates`; within a type, ascending id. The inventory module's own order (`Reservation → Balance`, balances by position id) is a suffix of it. Confirmation, allocation, release, cancel and wave operations all lock in this order; flows that learn the wave/order set from an unlocked read re-verify it after locking and ask the caller to retry (`CONFLICT`) on the rare change.
- **Guarded updates**: quantities change only through single-statement conditional UPDATEs (`pickedQty + q <= quantity`, `consumedQuantity + q <= quantity`, `reserved >= q`, `allocatedQty + q <= requestedQty`, …); CHECK constraints are the backstop. No read–compute–write on quantities.
- **Two workers completing the same task**: serialized on the wave/order/task locks; the second sees the task completed (`TASK_NOT_PICKABLE`) or too little remaining (`PICK_QUANTITY_EXCEEDED`).
- **Idempotency**: `Idempotency-Key` (header or body). The same key with the same request consumes stock once and returns the original result with `replayed: true`; the same key with a different request is a conflict. The picker screen sends a fresh key per attempt, so a double click or retry never double-picks. Allocation, release and cancel accept keys too.

## Permissions

`orders.view`, `orders.manage` (create, mark ready, cancel), `picking.view`, `picking.manage` (allocate, release allocation, waves, confirm picks). Owner and Admin have all four; Member has the two `view` permissions.

## UI

`/orders` (list, filters, manual order form), `/orders/{id}` (lines with requested/allocated/picked/not-allocated, tasks, actions: mark ready, allocate, release allocation, cancel), `/picking` (waves with progress, create wave), `/picking/{wave}` (add eligible orders, release, start, complete, cancel, task list), `/picking/tasks/{task}` (picker screen: order, SKU, source location, quantities, location/product/quantity confirmation, **Complete pick**).

## Not done / known limitations

- No task assignment to specific pickers; any user with `picking.manage` can confirm any task.
- No route optimization, batch/zone/cluster picking, or short-pick workflow (a short pick today is "cancel the task/order and reallocate").
- Order lines cannot be edited after creation (cancel and recreate).
- Waves only take whole orders' unassigned tasks (no per-task selection); tasks cannot be moved between waves except by cancelling the wave.
- Picked stock leaves the warehouse ledger at pick time (`PICK`); there is no staging location yet, which is where packing (next phase) will pick up.

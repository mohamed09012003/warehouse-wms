# Picking (design only — not implemented in Phase 0)

## Flow

```
Order(OPEN) ──► Wave planning ──► Allocation/Reservation ──► Release ──► PickTasks ──► Mobile picking ──► Picked stock in staging
```

1. **Orders** enter via UI, CSV or integration with status `OPEN`.
2. **Wave planning**: select orders (by carrier cut-off, zone, priority) into a `PickingWave` (`PLANNED`). Several orders → one wave (consolidation).
3. **Allocation**: for each order line, choose source balances via an allocation policy (closest/FIFO/FEFO/full-pallet-first; configurable per org) and **reserve** them through the inventory service (atomic, see inventory.md). Insufficient stock ⇒ line is partially allocated/backordered per policy; the wave records it.
4. **Release**: `RELEASED` generates `PickTask`s. Tasks for the same product+position across orders in a wave are **merged** (pick once, split at staging) when the wave strategy is batch picking; otherwise one task per order line (discrete).
5. **Task sequencing**: tasks ordered by a route heuristic derived from location structure (aisle/rack/bay/level) and floor-plan coordinates — data-driven, no hard-coded layout. Initially sort by rack code, bay, level; floor-plan-aware routing later.
6. **Execution (mobile)**: picker is assigned tasks and works through them.
7. **Completion**: each task moves stock from source position to a staging/cart position (`pick` inventory operation: consume reservation, −source, +staging). When all tasks are done, the wave completes and orders become `PICKED`, ready for packing.

## Pick task execution & verification

For each task the mobile UI:
1. Shows location (code, rack/level/bay, link to elevation view), product, quantity.
2. **Location verification**: scan location barcode/QR → compare to `fromPositionId` (via `(warehouseId, code)` lookup).
3. **Product verification**: scan product barcode → resolve via `ProductBarcode` (applying `packQty` multiples) → must equal task product.
4. Enter/confirm quantity (scan-per-unit or numeric).
5. Confirm → server completes the task transactionally. Wrong location/product scans are rejected and logged, never silently accepted.
6. **Short pick**: picker reports qty < planned with a reason; server completes task as `SHORT`, releases the remainder, flags the order line, and can trigger re-allocation or a cycle-count task for the location.

Server remains authoritative: the client only sends scan results/quantities; all checks re-run server-side. Completion calls are idempotent (task id + idempotency key) to survive flaky mobile connections.

## Data (see database.md)

`PickingWave`, `WaveOrder`, `PickTask`, `Reservation(+Lines)`. Task holds `fromPositionId`, `toPositionId`, `qtyPlanned`, `qtyPicked`, `status`, assignee, sequence.

## Status machines

- Wave: `PLANNED → RELEASED → IN_PROGRESS → COMPLETED | CANCELLED`
- Task: `PENDING → ASSIGNED → IN_PROGRESS → DONE | SHORT | CANCELLED`
- Cancelling a wave/task releases its remaining reservations in the same transaction.

## Module layout

`modules/picking/{domain (allocation policies, wave strategies, sequencing — pure), service, repo, schemas}`; mobile UI in `ui/features/picking-mobile` and routes under `app/pick/`. Camera/laser scanning uses the browser (`BarcodeDetector` or a small library, chosen in that phase) and keyboard-wedge scanners (they type into focused inputs, so the verify inputs must always work with plain text entry).

## Open questions (decide in the picking phase)

- Zone/batch/cluster picking strategies in v1 vs. discrete only.
- Pick-to-cart vs pick-to-order-tote staging model.
- Offline tolerance (deferred; initial assumption: connected Wi-Fi).

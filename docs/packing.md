# Packing (design only — not implemented in Phase 0)

## Flow

```
Picked orders ─► Packing queue ─► PackingSession (at a station) ─► Packages (+items) ─► Labels ─► Ready to ship
```

1. **Packing queue**: orders in `PICKED` (or partially picked, per policy), filterable by priority/carrier/station zone.
2. **Packing session**: a packer at a `PackingStation` opens a session for an order (one OPEN session per order — partial unique index). Consolidating multi-wave orders waits until all lines are picked unless partial shipment is allowed.
3. **Scanning**: packer scans product barcodes; server checks the product belongs to the order and quantity doesn't exceed `qtyPicked − qtyPacked`.
4. **Packages**: packer creates one or more `Package`s; each scan assigns units to a package as a `PackageItem`. Weight and dimensions are entered or read from a scale; both stored numerically (g, mm).
5. **Partial consumption of picked inventory**: picked stock sits in a staging position (from picking). Packing issues a `PACK` inventory operation consuming from staging **per scanned quantity**, so an order can be packed over several sessions/packages and staging balances always reflect what's left. Un-packing (removing an item from an open package) reverses it with a compensating movement.
6. **Closing**: closing a package freezes items; closing the session verifies `qtyPacked` vs `qtyPicked`, marks the order `PACKED` (or partial), and surfaces leftovers (return to stock via transfer, or hold).
7. **Labels**: for each closed package generate a shipping label and/or package/contents label. Label generation is behind a `LabelProvider` port: initial implementations render ZPL/PDF from templates locally; carrier-API labels (tracking numbers) come via integrations. Label payload or blob reference stored in `Label`.

## Rules & invariants

- `Σ PackageItem.qty per order line ≤ OrderLine.qtyPicked`.
- Packing operations are transactions: PackageItem insert + `qtyPacked` increment + inventory `PACK` movement succeed or fail together.
- Idempotent scans (scan id) so a double-fired scan doesn't double-pack.
- Package dimensions/weight positive when set; weight tolerance check vs expected (sum of product weights) is a configurable warning, not a hard block.
- Stations are data (`PackingStation`), optionally bound to a packing-area Position/zone on the floor plan.

## Data

`PackingStation`, `PackingSession`, `Package`, `PackageItem`, `Label` (see database.md). Carrier/tracking fields on Package are filled by integrations.

## Module layout

`modules/packing/{domain (verification, weight checks), service, repo, schemas}`; UI in `ui/features/packing`; it depends on `picking`/`inventory`/`orders` services only through their public APIs.

## Open questions

- Carton-size suggestion (box catalogue) — future; model `PackagingType` when needed (like `PalletType`, org-defined, mm).
- Multi-package kitting and serial capture — future.

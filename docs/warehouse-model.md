# Warehouse Model

The warehouse is **data**. No layout, rack count, bay count, level count or pallet size is hard-coded; the designer and all views render from the database.

## Physical hierarchy

```
Warehouse
 ├─ WarehouseObject*            (floor-plan items: wall, door, aisle, zones…)
 └─ Rack*                       (placed on the floor plan)
     ├─ RackLevel*              (tiers; levelIndex 0 = ground)
     ├─ Bay*                    (sections along the rack's length)
     └─ Position*               (level × bay × positionIndex)  ← storage location
```

All lengths are integer millimeters. Weights in grams.

## Coordinate system (floor plan)

- Origin top-left of the warehouse canvas, +x right, +y down, units mm. The canvas size is `Warehouse.widthMm × lengthMm`.
- Every placed item has `xMm, yMm` (the item's **center**), `widthMm`, `depthMm`, `rotationDeg` (0–359, clockwise). **Decision: x/y is the center and rotation is about the center**, which keeps rotation math trivial. The editor converts mm ↔ screen pixels with one scale factor; the DB never stores pixels.
- A rack's `lengthMm` runs along its local x axis, `depthMm` along local y. Rack front (the face pickers use) is local +y. Rotation by 0/90/180/270 is the norm; arbitrary angles are allowed for objects, snapped to 90° for racks by default in the UI (not enforced in DB).

## Warehouse objects

`WarehouseObject.type` ∈ WALL, DOOR, AISLE, LOADING_AREA, PACKING_AREA, WORK_AREA, ZONE, OTHER. Walls are thin rectangles (length × thickness) — simple and uniform; polylines can be added later without breaking this. `props Json` holds type-specific, non-queried extras (door swing side, colour, label style). Anything queried or constrained gets a real column.

Zones/areas can be linked to special Positions (e.g. a PACKING_AREA contains packing-station positions; a LOADING_AREA hosts RECEIVING/SHIPPING positions) via optional `zoneObjectId` on those positions so stock in non-rack locations still appears on the plan.

## Racks, levels, bays, positions

### Rack
`code` (unique per warehouse, e.g. `R01`), placement (x, y, rotation), `lengthMm`, `depthMm`, `heightMm`.

### Levels
`RackLevel(levelIndex, elevationMm, clearanceMm, maxLoadG, defaultPalletTypeId)`.
- `elevationMm`: height of the level's load-bearing beam/shelf above floor.
- `clearanceMm`: usable vertical space for goods on that level.
- Levels are ordered by `levelIndex` (0 = ground). Each level has its **own configuration**, so heights, loads and default pallet types differ per level.
- Validation: `elevation(n) + clearance(n) ≤ elevation(n+1)` and top level `elevation + clearance ≤ rack.heightMm`.

### Bays
`Bay(bayIndex, offsetMm, widthMm)`, ordered along the rack length. Bay widths are configurable and may differ.
- Validation: bays don't overlap; `sum(widthMm) ≤ rack.lengthMm`. Remaining length is "unallocated" (shown in the editor, allowed).
- **Generation helper (domain function)**: `suggestBays(rackLengthMm, bayWidthMm)` returns `floor(length / width)` bays and the leftover. Example only: 12 000 / 2 000 → 6 bays; 12 000 / 1 200 → 10 bays. It is a *proposal*; the admin confirms, and bays are stored as rows. Nothing assumes a count.
- Bays are rack-wide columns shared by all levels (a bay's width is the same on every level). If a customer needs different splits per level, that is a future extension (bay per level); not in v1 to keep things simple.

### Positions (locations)
A position is one storage place at (level, bay, `positionIndex`). Positions per bay-level are configurable: usually 1 for pallet racking, several for shelving/bins, or a depth index for deep racking.

**Capacity derivation / validation** (`warehouse/domain/capacity.ts`, pure):
- `positionsFit(bayWidthMm, rackDepthMm, palletType, orientation)` → how many pallets of the configured pallet type fit in a bay-level, in each orientation, accounting for configurable clearance gaps between pallets (`org.settings.palletGapMm`, default set in data, not code).
- Creating more positions in a bay-level than the physical fit → validation error (can be overridden by an explicit `allowOverfit` flag stored on the position for odd cases; default blocked).
- Load: `position.maxLoadG ≤ level.maxLoadG`.
- Pallet assignment: `Position.palletTypeId` (optional) or inherited from `level.defaultPalletTypeId`. A product placement may check pallet dimensions against the position's allowed type (a policy, enforced in the inventory service when enabled).

### Why positions are persisted rows
Inventory needs a stable FK target, scanners need stable codes, and history must survive layout edits. Positions are generated from the configuration ("generate positions for this rack") and then editable individually.

## Layout edit rules (safety)

- Moving/rotating/resizing a rack changes only geometry; codes and positions are unaffected.
- Changing bay widths/count or levels never deletes positions with stock or movement history. Such positions are **archived** (`archivedAt`) and hidden; shrinking over occupied positions is rejected with a list of conflicts.
- Layout saves are transactional and versioned optimistically (`Warehouse.layoutVersion`); concurrent editors get a conflict, not silent overwrite.
- Rack footprints must lie within the canvas; overlap between racks is a *warning* in the UI, not a DB constraint (objects may legitimately overlap, e.g. a zone under racks).

## Location codes

**Structured identifiers are the source of truth** (rack → `Rack.code`, level → `RackLevel.levelIndex`, bay → `Bay.bayIndex`, position → `Position.positionIndex`). The string is generated and stored as `Position.code` for fast unique lookup, scanning and printing.

Format (default; organization-configurable template in settings):

```
{rack}-L{level:2}-B{bay:2}-P{position:2}      e.g. R01-L01-B03-P02
```

- `rack` uses `Rack.code` as-is (the admin chooses `R01`; the system may suggest the next number).
- Numeric parts are zero-padded to the configured width (default 2; wider automatically if the number needs it, e.g. level 100).
- **Numbering base**: `levelIndex` 0 = ground in the DB/elevation view. The code uses a **1-based** display number (`levelIndex + 1`) by default so the ground level prints as `L01`, matching the example; bays and positions are 1-based (`bayIndex`/`positionIndex` stored 1-based; levelIndex stored 0-based). The display offset is a single constant in the code generator, documented here, and part of the org's template config. Decide/confirm in review.
- Codes are generated by a pure function `formatLocationCode(parts, template)` and **parsed** by `parseLocationCode` for scanner input (scanners also resolve via lookup by `(warehouseId, code)`; parsing is only a fast pre-validation).
- Uniqueness: `unique(warehouseId, code)`.
- Renaming a rack code or changing the template regenerates affected codes in one transaction; old codes are kept in a `PositionCodeHistory` (or movement history carries position ids, so audit is unaffected). Printed labels with old codes should keep resolving through history (small table, added when renaming is built).
- Special (non-rack) positions use an explicit admin-chosen code (e.g. `RCV-01`, `PACK-03`) in a reserved prefix namespace validated against rack codes.

## Visualizations (design only — built in later phases)

### 1. Floor plan (top-down)
Rendered from `WarehouseObject` + `Rack` rows (+ special positions). Capabilities: zoom, pan, select, move, rotate (racks), edit dimensions in an inspector panel, save (single transactional "save layout" call with `layoutVersion`). Rendering tech: React Konva (canvas) or SVG — decide in the designer phase with a short spike; the **data contract is independent** of renderer: `GET /layout` returns `{objects[], racks[], version}`. Optional heat overlay: occupancy per rack.

### 2. Rack elevation (front view)
Select a rack → front view drawn from `RackLevel` (elevation/clearance) × `Bay` (offset/width). Rows = levels top-down, columns = bays, cells = positions. Selecting a level/bay shows positions and their stock (products, qty, reserved). Scale: mm → px as in the plan. Pure SVG is likely sufficient here (DOM events on cells, accessible, easy to test).

Both views are 2D; no 3D.

## Example (illustrative data, not code)

Rack `R01`: length 12 000, depth 1 100, height 6 000. Levels: 0 (elev 150), 1 (elev 1 650), 2 (elev 3 150), 3 (elev 4 650), each clearance 1 400. Bays: 6 × 2 000 mm. One pallet position per bay-level ⇒ 24 positions `R01-L01-B01-P01 … R01-L04-B06-P01`. All numbers come from rows an admin entered.

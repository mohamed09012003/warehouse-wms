"use client";

import type { Dispatch } from "react";
import type { LayoutObjectDto, LayoutRackDto, PalletTypeDto } from "@/modules/warehouse/types";
import { Button } from "@/ui/primitives/button";
import { NumberField, TextField, selectClass } from "./fields";
import type { DesignerAction, DesignerState } from "./model/designerState";
import { GRID_SIZES_MM, OBJECT_PRESETS } from "./model/presets";
import { RackStructureEditor } from "./RackStructureEditor";

export function Inspector({
  state,
  dispatch,
  palletTypes,
  readOnly,
}: {
  state: DesignerState;
  dispatch: Dispatch<DesignerAction>;
  palletTypes: readonly PalletTypeDto[];
  readOnly: boolean;
}) {
  const sel = state.selection;
  const rack = sel?.kind === "rack" ? state.racks.find((r) => r.id === sel.id) : undefined;
  const object = sel?.kind === "object" ? state.objects.find((o) => o.id === sel.id) : undefined;

  if (rack) return <RackInspector rack={rack} dispatch={dispatch} palletTypes={palletTypes} readOnly={readOnly} />;
  if (object) return <ObjectInspector object={object} dispatch={dispatch} readOnly={readOnly} />;

  const { warehouse, grid } = state;
  return (
    <div className="space-y-4" data-testid="inspector-warehouse">
      <h3 className="font-medium">Warehouse</h3>
      <TextField label="Name" value={warehouse.name} disabled={readOnly} onCommit={(name) => dispatch({ type: "setWarehouse", patch: { name } })} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Width" min={1} value={warehouse.widthMm} disabled={readOnly} onCommit={(widthMm) => dispatch({ type: "setWarehouse", patch: { widthMm } })} />
        <NumberField label="Length" min={1} value={warehouse.lengthMm} disabled={readOnly} onCommit={(lengthMm) => dispatch({ type: "setWarehouse", patch: { lengthMm } })} />
      </div>
      <p className="text-xs text-muted-foreground">
        {(warehouse.widthMm / 1000).toFixed(1)} m × {(warehouse.lengthMm / 1000).toFixed(1)} m
      </p>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="grid-size">
          Grid size
        </label>
        <select id="grid-size" className={selectClass} value={grid.sizeMm} onChange={(e) => dispatch({ type: "setGrid", patch: { sizeMm: Number(e.target.value) } })}>
          {GRID_SIZES_MM.map((s) => (
            <option key={s} value={s}>
              {s} mm
            </option>
          ))}
        </select>
      </div>
      <p className="text-xs text-muted-foreground">
        Select an item on the plan to edit it. Drag to move, <kbd>R</kbd> rotates 90°, <kbd>Delete</kbd> removes, arrow keys nudge by one grid step. Drag the background to pan, scroll to zoom.
      </p>
    </div>
  );
}

function PositionFields({
  item,
  dispatch,
  readOnly,
  kind,
}: {
  item: { id: string; xMm: number; yMm: number; rotationDeg: number };
  dispatch: Dispatch<DesignerAction>;
  readOnly: boolean;
  kind: "rack" | "object";
}) {
  const update = (patch: Record<string, number>) =>
    dispatch(kind === "rack" ? { type: "updateRack", id: item.id, patch } : { type: "updateObject", id: item.id, patch });
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="X (center)" min={-500000} value={item.xMm} disabled={readOnly} onCommit={(xMm) => update({ xMm })} />
        <NumberField label="Y (center)" min={-500000} value={item.yMm} disabled={readOnly} onCommit={(yMm) => update({ yMm })} />
      </div>
      <div className="flex items-end gap-2">
        <NumberField
          className="flex-1"
          label="Rotation"
          unit="°"
          value={item.rotationDeg}
          disabled={readOnly}
          onCommit={(deg) => update({ rotationDeg: ((deg % 360) + 360) % 360 })}
        />
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={() => dispatch({ type: "rotateItem", selection: { kind, id: item.id }, deltaDeg: -90 })}>
          ⟲ 90°
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={readOnly} onClick={() => dispatch({ type: "rotateItem", selection: { kind, id: item.id }, deltaDeg: 90 })}>
          ⟳ 90°
        </Button>
      </div>
    </>
  );
}

function ObjectInspector({ object, dispatch, readOnly }: { object: LayoutObjectDto; dispatch: Dispatch<DesignerAction>; readOnly: boolean }) {
  const update = (patch: Partial<LayoutObjectDto>) => dispatch({ type: "updateObject", id: object.id, patch });
  return (
    <div className="space-y-4" data-testid="inspector-object">
      <h3 className="font-medium">{OBJECT_PRESETS[object.type].label}</h3>
      <TextField label="Label" value={object.label ?? ""} disabled={readOnly} placeholder={OBJECT_PRESETS[object.type].label} onCommit={(label) => update({ label: label || null })} />
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Length" min={1} value={object.widthMm} disabled={readOnly} onCommit={(widthMm) => update({ widthMm })} />
        <NumberField label="Depth" min={1} value={object.depthMm} disabled={readOnly} onCommit={(depthMm) => update({ depthMm })} />
      </div>
      <PositionFields item={object} dispatch={dispatch} readOnly={readOnly} kind="object" />
      <Button type="button" variant="destructive" size="sm" disabled={readOnly} onClick={() => dispatch({ type: "deleteSelected" })}>
        Delete
      </Button>
    </div>
  );
}

function RackInspector({
  rack,
  dispatch,
  palletTypes,
  readOnly,
}: {
  rack: LayoutRackDto;
  dispatch: Dispatch<DesignerAction>;
  palletTypes: readonly PalletTypeDto[];
  readOnly: boolean;
}) {
  const update = (patch: Partial<LayoutRackDto>) => dispatch({ type: "updateRack", id: rack.id, patch });
  return (
    <div className="space-y-4" data-testid="inspector-rack">
      <h3 className="font-medium">Rack {rack.code}</h3>
      <div className="grid grid-cols-2 gap-2">
        <TextField label="Code" value={rack.code} disabled={readOnly} onCommit={(v) => update({ code: v.toUpperCase() })} />
        <TextField label="Name" value={rack.name ?? ""} disabled={readOnly} onCommit={(v) => update({ name: v || null })} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <NumberField label="Length" min={1} value={rack.lengthMm} disabled={readOnly} onCommit={(lengthMm) => update({ lengthMm })} />
        <NumberField label="Depth" min={1} value={rack.depthMm} disabled={readOnly} onCommit={(depthMm) => update({ depthMm })} />
        <NumberField label="Height" min={1} value={rack.heightMm} disabled={readOnly} onCommit={(heightMm) => update({ heightMm })} />
      </div>
      <PositionFields item={rack} dispatch={dispatch} readOnly={readOnly} kind="rack" />
      <hr />
      <RackStructureEditor rack={rack} palletTypes={palletTypes} disabled={readOnly} onChange={(patch) => update(patch)} />
      <Button type="button" variant="destructive" size="sm" disabled={readOnly} onClick={() => dispatch({ type: "deleteSelected" })}>
        Delete rack
      </Button>
    </div>
  );
}

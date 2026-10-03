"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { WarehouseObjectTypeName } from "@/modules/warehouse/schemas";
import type { LayoutDto, PalletTypeDto, RackElevationDto } from "@/modules/warehouse/types";
import { Button } from "@/ui/primitives/button";
import { ApiError, warehouseApi } from "./api";
import { selectClass } from "./fields";
import { FloorPlanCanvas, type CanvasHandle } from "./FloorPlanCanvas";
import { Inspector } from "./Inspector";
import { designerReducer, initialState, toSavePayload } from "./model/designerState";
import { GRID_SIZES_MM, OBJECT_PRESETS } from "./model/presets";
import { validateDraft } from "./model/validation";
import { RackElevation } from "./RackElevation";

const ADDABLE: WarehouseObjectTypeName[] = ["WALL", "DOOR", "AISLE", "LOADING_AREA", "PACKING_AREA", "WORK_AREA"];

export function WarehouseDesigner({
  orgSlug,
  initialLayout,
  palletTypes,
  canEdit,
}: {
  orgSlug: string;
  initialLayout: LayoutDto;
  palletTypes: PalletTypeDto[];
  canEdit: boolean;
}) {
  const readOnly = !canEdit;
  const [state, dispatch] = useReducer(designerReducer, initialLayout, initialState);
  const canvas = useRef<CanvasHandle>(null);
  const [saved, setSaved] = useState<LayoutDto>(initialLayout);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "ok" | "error"; message?: string }>({ kind: "idle" });
  const [elevation, setElevation] = useState<{ rackId: string; data?: RackElevationDto; error?: string } | null>(null);

  const issues = useMemo(() => validateDraft(state, palletTypes), [state, palletTypes]);
  const errors = issues.filter((i) => i.severity === "error");
  const errorIds = useMemo(() => new Set(errors.flatMap((i) => (i.itemId ? [i.itemId] : []))), [errors]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!state.dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.dirty]);

  const add = (type: "rack" | WarehouseObjectTypeName) => {
    const at = canvas.current?.viewCenterMm() ?? { xMm: state.warehouse.widthMm / 2, yMm: state.warehouse.lengthMm / 2 };
    const id = crypto.randomUUID();
    dispatch(type === "rack" ? { type: "addRack", id, at } : { type: "addObject", id, objectType: type, at });
  };

  const save = useCallback(async () => {
    setStatus({ kind: "saving" });
    try {
      const layout = await warehouseApi.saveLayout(orgSlug, state.warehouse.id, toSavePayload(state));
      dispatch({ type: "load", layout });
      setSaved(layout);
      setStatus({ kind: "ok", message: `Saved (version ${layout.warehouse.layoutVersion})` });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "Could not save the layout" });
    }
  }, [orgSlug, state]);

  const reload = useCallback(async () => {
    try {
      const layout = await warehouseApi.getLayout(orgSlug, state.warehouse.id);
      dispatch({ type: "load", layout });
      setSaved(layout);
      setStatus({ kind: "ok", message: "Reloaded from the server" });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "Could not reload" });
    }
  }, [orgSlug, state.warehouse.id]);

  // Elevation is loaded from the database for the selected, already-saved rack.
  const selectedRackId = state.selection?.kind === "rack" ? state.selection.id : null;
  const savedRack = saved.racks.find((r) => r.id === selectedRackId);
  const savedVersion = saved.warehouse.layoutVersion;
  useEffect(() => {
    if (!selectedRackId || !savedRack) return;
    let cancelled = false;
    warehouseApi
      .getElevation(orgSlug, saved.warehouse.id, selectedRackId)
      .then((data) => !cancelled && setElevation({ rackId: selectedRackId, data }))
      .catch((e) => !cancelled && setElevation({ rackId: selectedRackId, error: e instanceof Error ? e.message : "Failed to load" }));
    return () => {
      cancelled = true;
    };
    // Reload when the selection changes or a save produced a new version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRackId, !!savedRack, savedVersion, orgSlug]);

  const draftRack = state.racks.find((r) => r.id === selectedRackId);
  const rackChanged = draftRack && savedRack && JSON.stringify(draftRack) !== JSON.stringify(savedRack);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2" role="toolbar" aria-label="Designer tools">
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" disabled={readOnly} onClick={() => add("rack")}>
            + Rack
          </Button>
          {ADDABLE.map((t) => (
            <Button key={t} size="sm" variant="outline" disabled={readOnly} onClick={() => add(t)}>
              + {OBJECT_PRESETS[t].label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="outline" onClick={() => canvas.current?.zoomBy(1 / 1.25)} aria-label="Zoom out">
            −
          </Button>
          <Button size="sm" variant="outline" onClick={() => canvas.current?.zoomBy(1.25)} aria-label="Zoom in">
            +
          </Button>
          <Button size="sm" variant="outline" onClick={() => canvas.current?.fit()}>
            Fit
          </Button>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={state.grid.show} onChange={(e) => dispatch({ type: "setGrid", patch: { show: e.target.checked } })} /> Grid
          </label>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={state.grid.snap} onChange={(e) => dispatch({ type: "setGrid", patch: { snap: e.target.checked } })} /> Snap
          </label>
          <select
            aria-label="Grid size"
            className={`${selectClass} !w-24`}
            value={state.grid.sizeMm}
            onChange={(e) => dispatch({ type: "setGrid", patch: { sizeMm: Number(e.target.value) } })}
          >
            {GRID_SIZES_MM.map((s) => (
              <option key={s} value={s}>
                {s} mm
              </option>
            ))}
          </select>
          {!readOnly && (
            <>
              <Button size="sm" variant="outline" disabled={status.kind === "saving"} onClick={reload}>
                {state.dirty ? "Discard changes" : "Reload"}
              </Button>
              <Button size="sm" disabled={!state.dirty || errors.length > 0 || status.kind === "saving"} onClick={save}>
                {status.kind === "saving" ? "Saving…" : "Save layout"}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-sm" aria-live="polite">
        <span className="font-medium">
          {state.warehouse.name} <span className="text-muted-foreground">({state.warehouse.code})</span>
        </span>
        {readOnly && <span className="rounded bg-muted px-2 py-0.5 text-xs">Read-only</span>}
        {state.dirty && <span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs">Unsaved changes</span>}
        {status.kind === "ok" && !state.dirty && <span className="text-xs text-emerald-600">{status.message}</span>}
        {status.kind === "error" && (
          <span role="alert" className="text-xs text-destructive">
            {status.message}
          </span>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border p-3 text-xs" data-testid="issues">
          {issues.slice(0, 6).map((i, k) => (
            <li key={k} className={i.severity === "error" ? "text-destructive" : "text-amber-600"}>
              {i.severity === "error" ? "Error" : "Warning"}: {i.message}
            </li>
          ))}
          {issues.length > 6 && <li className="text-muted-foreground">…and {issues.length - 6} more</li>}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="h-[34rem]">
          <FloorPlanCanvas ref={canvas} state={state} dispatch={dispatch} readOnly={readOnly} errorIds={errorIds} />
        </div>
        <aside className="max-h-[34rem] overflow-y-auto rounded-lg border p-4">
          <Inspector state={state} dispatch={dispatch} palletTypes={palletTypes} readOnly={readOnly} />
        </aside>
      </div>

      {selectedRackId && (
        <section className="rounded-lg border p-4" aria-label="Rack elevation">
          {!savedRack ? (
            <p className="text-sm text-muted-foreground">This rack has not been saved yet. Save the layout to generate its elevation view.</p>
          ) : elevation?.rackId === selectedRackId && elevation.data ? (
            <>
              {rackChanged && <p className="mb-3 rounded bg-amber-500/15 px-3 py-2 text-xs">Showing the last saved configuration. Save the layout to apply your unsaved rack changes.</p>}
              <RackElevation key={selectedRackId} data={elevation.data} />
            </>
          ) : elevation?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {elevation.error}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">Loading elevation…</p>
          )}
        </section>
      )}
    </div>
  );
}

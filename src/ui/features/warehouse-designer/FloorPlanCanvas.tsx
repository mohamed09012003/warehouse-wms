"use client";

import { formatInt } from "@/lib/format";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from "react";
import { bayOffsets } from "@/modules/warehouse/domain/structure";
import type { LayoutObjectDto, LayoutRackDto } from "@/modules/warehouse/types";
import type { DesignerAction, DesignerState, Selection } from "./model/designerState";
import { OBJECT_PRESETS } from "./model/presets";

export interface CanvasHandle {
  zoomBy(factor: number): void;
  fit(): void;
  /** Center of the visible area in world (mm) coordinates, for placing new items. */
  viewCenterMm(): { xMm: number; yMm: number };
}

interface View {
  zoom: number; // pixels per millimetre
  panX: number;
  panY: number;
}

const MIN_ZOOM = 0.002;
const MAX_ZOOM = 2;

type Drag =
  | { kind: "item"; selection: NonNullable<Selection>; offX: number; offY: number }
  | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
  | null;

const OBJECT_CLASS: Record<LayoutObjectDto["type"], string> = {
  WALL: "fill-slate-600 stroke-slate-700",
  DOOR: "fill-amber-400/70 stroke-amber-600",
  AISLE: "fill-slate-400/20 stroke-slate-500 [stroke-dasharray:6_4]",
  LOADING_AREA: "fill-sky-400/25 stroke-sky-600",
  PACKING_AREA: "fill-emerald-400/25 stroke-emerald-600",
  WORK_AREA: "fill-violet-400/25 stroke-violet-600",
};

export const FloorPlanCanvas = forwardRef<
  CanvasHandle,
  { state: DesignerState; dispatch: Dispatch<DesignerAction>; readOnly: boolean; errorIds: ReadonlySet<string> }
>(function FloorPlanCanvas({ state, dispatch, readOnly, errorIds }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ zoom: 0.02, panX: 20, panY: 20 });
  const drag = useRef<Drag>(null);
  const fitted = useRef(false);
  const { widthMm, lengthMm } = state.warehouse;

  const fitView = useCallback(
    (w = size.w, h = size.h) => {
      if (!w || !h) return;
      const pad = 24;
      const zoom = Math.min(Math.max(Math.min((w - pad * 2) / widthMm, (h - pad * 2) / lengthMm), MIN_ZOOM), MAX_ZOOM);
      setView({ zoom, panX: (w - widthMm * zoom) / 2, panY: (h - lengthMm * zoom) / 2 });
    },
    [size.w, size.h, widthMm, lengthMm],
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize({ w, h });
      if (!fitted.current && w && h) {
        fitted.current = true;
        fitView(w, h);
      }
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const zoom = Math.min(Math.max(v.zoom * factor, MIN_ZOOM), MAX_ZOOM);
      const k = zoom / v.zoom;
      return { zoom, panX: cx - (cx - v.panX) * k, panY: cy - (cy - v.panY) * k };
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      zoomBy: (factor) => zoomAt(factor, size.w / 2, size.h / 2),
      fit: () => fitView(),
      viewCenterMm: () => ({ xMm: (size.w / 2 - view.panX) / view.zoom, yMm: (size.h / 2 - view.panY) / view.zoom }),
    }),
    [zoomAt, fitView, size, view],
  );

  // Wheel zoom needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const toWorld = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left - view.panX) / view.zoom, y: (e.clientY - rect.top - view.panY) / view.zoom };
  };

  const startItemDrag = (e: React.PointerEvent, selection: NonNullable<Selection>, item: { xMm: number; yMm: number }) => {
    e.stopPropagation();
    dispatch({ type: "select", selection });
    containerRef.current?.focus();
    if (readOnly) return;
    const p = toWorld(e);
    drag.current = { kind: "item", selection, offX: p.x - item.xMm, offY: p.y - item.yMm };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    dispatch({ type: "select", selection: null });
    containerRef.current?.focus();
    drag.current = { kind: "pan", startX: e.clientX, startY: e.clientY, panX: view.panX, panY: view.panY };
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, panX: d.panX + e.clientX - d.startX, panY: d.panY + e.clientY - d.startY }));
    } else {
      const p = toWorld(e);
      dispatch({ type: "moveItem", selection: d.selection, xMm: p.x - d.offX, yMm: p.y - d.offY });
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    drag.current = null;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const sel = state.selection;
    if (e.key === "Escape") return dispatch({ type: "select", selection: null });
    if (!sel || readOnly) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "deleteSelected" });
    } else if (e.key.toLowerCase() === "r") {
      dispatch({ type: "rotateItem", selection: sel, deltaDeg: e.shiftKey ? -90 : 90 });
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const item = sel.kind === "rack" ? state.racks.find((r) => r.id === sel.id) : state.objects.find((o) => o.id === sel.id);
      if (!item) return;
      const step = state.grid.sizeMm;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      dispatch({ type: "moveItem", selection: sel, xMm: item.xMm + dx, yMm: item.yMm + dy });
    }
  };

  // Draw the grid no finer than ~8px so it never turns into noise when zoomed out.
  const gridStep = useMemo(() => {
    let step = state.grid.sizeMm;
    while (step * view.zoom < 8 && step < 1_000_000) step *= 2;
    return step;
  }, [state.grid.sizeMm, view.zoom]);

  const fontPx = 12 / view.zoom;
  const isSelected = (kind: "rack" | "object", id: string) => state.selection?.kind === kind && state.selection.id === id;

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="floorplan"
      className="relative h-full min-h-[24rem] w-full overflow-hidden rounded-lg border bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        ref={svgRef}
        className="h-full w-full touch-none select-none"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="img"
        aria-label="Warehouse floor plan"
      >
        <defs>
          <pattern id="wms-grid" width={gridStep} height={gridStep} patternUnits="userSpaceOnUse">
            <path d={`M ${gridStep} 0 H 0 V ${gridStep}`} fill="none" className="stroke-foreground/25" strokeWidth={1 / view.zoom} />
          </pattern>
        </defs>
        <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
          <rect x={0} y={0} width={widthMm} height={lengthMm} className="fill-background stroke-foreground/40" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          {state.grid.show && <rect x={0} y={0} width={widthMm} height={lengthMm} fill="url(#wms-grid)" pointerEvents="none" />}

          {state.objects.map((o) => (
            <ObjectShape
              key={o.id}
              o={o}
              selected={isSelected("object", o.id)}
              hasError={errorIds.has(o.id)}
              fontPx={fontPx}
              onDown={(e) => startItemDrag(e, { kind: "object", id: o.id }, o)}
            />
          ))}
          {state.racks.map((r) => (
            <RackShape
              key={r.id}
              r={r}
              selected={isSelected("rack", r.id)}
              hasError={errorIds.has(r.id)}
              fontPx={fontPx}
              onDown={(e) => startItemDrag(e, { kind: "rack", id: r.id }, r)}
            />
          ))}
        </g>
      </svg>
      <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">
        {formatInt(widthMm)} × {formatInt(lengthMm)} mm · grid {state.grid.sizeMm} mm · 1 m = {Math.round(view.zoom * 1000)} px
      </div>
    </div>
  );
});

function frame(selected: boolean, hasError: boolean) {
  return {
    strokeWidth: selected ? 3 : 1.5,
    vectorEffect: "non-scaling-stroke" as const,
    className: selected ? "!stroke-primary" : hasError ? "!stroke-red-500" : undefined,
  };
}

function ObjectShape({
  o,
  selected,
  hasError,
  fontPx,
  onDown,
}: {
  o: LayoutObjectDto;
  selected: boolean;
  hasError: boolean;
  fontPx: number;
  onDown: (e: React.PointerEvent) => void;
}) {
  const f = frame(selected, hasError);
  const w = o.widthMm;
  const d = o.depthMm;
  const label = o.label || OBJECT_PRESETS[o.type].label;
  const showLabel = o.type !== "WALL" && o.type !== "DOOR";
  return (
    <g transform={`translate(${o.xMm} ${o.yMm})`} onPointerDown={onDown} className="cursor-move" data-object-id={o.id} data-object-type={o.type}>
      <g transform={`rotate(${o.rotationDeg})`}>
        <rect x={-w / 2} y={-d / 2} width={w} height={d} className={`${OBJECT_CLASS[o.type]} ${f.className ?? ""}`} strokeWidth={f.strokeWidth} vectorEffect={f.vectorEffect} />
        {o.type === "DOOR" && (
          <path
            d={`M ${-w / 2} 0 L ${-w / 2} ${-w} M ${w / 2} 0 A ${w} ${w} 0 0 0 ${-w / 2} ${-w}`}
            fill="none"
            className="stroke-amber-600"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </g>
      {showLabel && (
        <text textAnchor="middle" dominantBaseline="middle" fontSize={fontPx} className="fill-foreground/80" pointerEvents="none">
          {label}
        </text>
      )}
    </g>
  );
}

function RackShape({
  r,
  selected,
  hasError,
  fontPx,
  onDown,
}: {
  r: LayoutRackDto;
  selected: boolean;
  hasError: boolean;
  fontPx: number;
  onDown: (e: React.PointerEvent) => void;
}) {
  const f = frame(selected, hasError);
  const offsets = bayOffsets(r.bays);
  const x0 = -r.lengthMm / 2;
  return (
    <g transform={`translate(${r.xMm} ${r.yMm})`} onPointerDown={onDown} className="cursor-move" data-rack-id={r.id} data-rack-code={r.code}>
      <g transform={`rotate(${r.rotationDeg})`}>
        <rect x={x0} y={-r.depthMm / 2} width={r.lengthMm} height={r.depthMm} className={`fill-blue-500/15 stroke-blue-600 ${f.className ?? ""}`} strokeWidth={f.strokeWidth} vectorEffect={f.vectorEffect} />
        {/* Bay dividers come from the rack's bay configuration, not from a fixed pattern. */}
        {offsets.slice(1).map((off, i) => (
          <line key={i} x1={x0 + off} x2={x0 + off} y1={-r.depthMm / 2} y2={r.depthMm / 2} className="stroke-blue-600/70" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {/* Front (pick) face is the local +y edge. */}
        <line x1={x0} x2={x0 + r.lengthMm} y1={r.depthMm / 2} y2={r.depthMm / 2} className="stroke-blue-700" strokeWidth={4} vectorEffect="non-scaling-stroke" />
      </g>
      <text textAnchor="middle" dominantBaseline="middle" fontSize={fontPx} fontWeight={600} className="fill-foreground" pointerEvents="none">
        {r.code}
      </text>
    </g>
  );
}

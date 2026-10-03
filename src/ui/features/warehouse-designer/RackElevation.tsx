"use client";

import { formatInt } from "@/lib/format";
import { useState } from "react";
import { formatLocationCode, levelDisplayNumber } from "@/modules/warehouse/domain/locationCode";
import type { RackElevationDto } from "@/modules/warehouse/types";
import { Button } from "@/ui/primitives/button";

/**
 * Front (elevation) view of a rack, drawn entirely from the stored configuration:
 * levels (beam height + clearance), bays (offset + width) and positions.
 * Display codes are generated from the structured fields, not read from the stored string.
 */
export function RackElevation({ data }: { data: RackElevationDto }) {
  const { rack, levels, bays, positions } = data;
  const [selected, setSelected] = useState(0);
  const levelIndex = levels.some((l) => l.levelIndex === selected) ? selected : (levels[0]?.levelIndex ?? 0);
  const level = levels.find((l) => l.levelIndex === levelIndex);

  const pad = 120;
  const W = rack.lengthMm;
  const H = rack.heightMm;
  const beam = Math.max(40, Math.round(H / 120));
  const upright = Math.max(50, Math.round(W / 250));
  const codeOf = (p: { levelIndex: number; bayIndex: number; positionIndex: number }) => formatLocationCode({ rackCode: rack.code, ...p });
  const levelPositions = positions.filter((p) => p.levelIndex === levelIndex);

  return (
    <div className="space-y-4" data-testid="rack-elevation">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">
          Rack {rack.code}
          {rack.name ? ` · ${rack.name}` : ""} — elevation
        </h3>
        <span className="text-xs text-muted-foreground">
          {formatInt(rack.lengthMm)} × {formatInt(rack.depthMm)} × {formatInt(rack.heightMm)} mm · {levels.length} levels · {bays.length} bays · {positions.length} positions
        </span>
      </div>

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Rack levels">
        {[...levels].reverse().map((l) => (
          <Button
            key={l.id}
            type="button"
            size="sm"
            role="tab"
            aria-selected={l.levelIndex === levelIndex}
            variant={l.levelIndex === levelIndex ? "default" : "outline"}
            onClick={() => setSelected(l.levelIndex)}
          >
            Level {levelDisplayNumber(l.levelIndex)}
          </Button>
        ))}
      </div>

      <svg viewBox={`${-pad} ${-pad} ${W + pad * 2} ${H + pad * 2}`} className="max-h-80 w-full" role="img" aria-label={`Elevation of rack ${rack.code}`} preserveAspectRatio="xMidYMid meet">
        <rect x={0} y={H} width={W} height={20} className="fill-foreground/30" />
        {levels.map((l) => {
          const top = H - (l.elevationMm + l.clearanceMm);
          const isSel = l.levelIndex === levelIndex;
          return (
            <g key={l.id} data-level-index={l.levelIndex} className="cursor-pointer" onClick={() => setSelected(l.levelIndex)}>
              <rect x={0} y={top} width={W} height={l.clearanceMm} className={isSel ? "fill-amber-400/25" : "fill-blue-500/5"} />
              {bays.map((b) => {
                const ps = positions.filter((p) => p.levelIndex === l.levelIndex && p.bayIndex === b.bayIndex);
                const slot = b.widthMm / Math.max(ps.length, 1);
                return ps.map((p, k) => (
                  <rect
                    key={p.id}
                    data-position-code={codeOf(p)}
                    x={b.offsetMm + k * slot + slot * 0.06}
                    y={top + l.clearanceMm * 0.08}
                    width={slot * 0.88}
                    height={l.clearanceMm * 0.84}
                    rx={Math.min(slot, l.clearanceMm) * 0.04}
                    className={isSel ? "fill-amber-400/40 stroke-amber-600" : "fill-blue-500/15 stroke-blue-600/60"}
                    strokeWidth={Math.max(8, W / 600)}
                  />
                ));
              })}
              <rect x={0} y={H - l.elevationMm} width={W} height={beam} className="fill-orange-500" />
            </g>
          );
        })}
        {/* uprights at each bay boundary */}
        {[...bays.map((b) => b.offsetMm), bays.length ? bays[bays.length - 1].offsetMm + bays[bays.length - 1].widthMm : W].map((x, i) => (
          <rect key={i} x={Math.min(Math.max(x - upright / 2, 0), W - upright)} y={0} width={upright} height={H} className="fill-blue-700" />
        ))}
      </svg>

      <div data-testid="level-detail" className="space-y-3">
        <h4 className="text-sm font-medium">
          Level {levelDisplayNumber(levelIndex)}
          {level && (
            <span className="ml-2 font-normal text-muted-foreground">
              beam at {formatInt(level.elevationMm)} mm · clearance {formatInt(level.clearanceMm)} mm
            </span>
          )}
        </h4>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {bays.map((b) => {
            const ps = levelPositions.filter((p) => p.bayIndex === b.bayIndex);
            return (
              <div key={b.id} className="rounded-lg border p-3 text-sm" data-testid={`bay-card-${b.bayIndex}`}>
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">Bay {String(b.bayIndex).padStart(2, "0")}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatInt(b.widthMm)} × {formatInt(rack.depthMm)} mm
                    {level ? ` × ${formatInt(level.clearanceMm)}` : ""}
                  </span>
                </div>
                <div className="mb-2 text-xs text-muted-foreground">
                  {b.palletType ? `${b.palletType.name} (${b.palletType.widthMm}×${b.palletType.lengthMm} mm)` : "No pallet type"}
                </div>
                <ul className="flex flex-wrap gap-1">
                  {ps.map((p) => (
                    <li key={p.id} className="rounded border bg-muted px-2 py-1 font-mono text-xs" title="Empty — inventory arrives in a later phase">
                      {codeOf(p)}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Stored inventory will appear on these positions once inventory is implemented.</p>
      </div>
    </div>
  );
}

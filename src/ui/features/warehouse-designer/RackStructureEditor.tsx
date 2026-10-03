"use client";

import { formatInt } from "@/lib/format";
import { useState } from "react";
import { bayOffsets, suggestBays, suggestLevels, totalPositions } from "@/modules/warehouse/domain/structure";
import { levelDisplayNumber } from "@/modules/warehouse/domain/locationCode";
import type { LayoutRackDto, PalletTypeDto } from "@/modules/warehouse/types";
import { Button } from "@/ui/primitives/button";
import { NumberField, selectClass } from "./fields";
import { RACK_PRESET } from "./model/presets";

/** Edits a rack's levels and bays. Positions are derived from this configuration on save. */
export function RackStructureEditor({
  rack,
  palletTypes,
  disabled,
  onChange,
}: {
  rack: LayoutRackDto;
  palletTypes: readonly PalletTypeDto[];
  disabled: boolean;
  onChange: (patch: Pick<LayoutRackDto, "levels"> | Pick<LayoutRackDto, "bays">) => void;
}) {
  const [bayWidth, setBayWidth] = useState<number>(rack.bays[0]?.widthMm ?? RACK_PRESET.bayWidthMm);
  const [defaultPositions, setDefaultPositions] = useState(1);
  const [defaultPallet, setDefaultPallet] = useState<string>("");

  const used = bayOffsets(rack.bays).at(-1) !== undefined ? bayOffsets(rack.bays).at(-1)! + rack.bays.at(-1)!.widthMm : 0;
  const palletName = (id?: string | null) => palletTypes.find((p) => p.id === id)?.name;

  const setLevelCount = (n: number) => {
    if (n < 1 || n > 30) return;
    onChange({
      levels: suggestLevels(rack.heightMm, n, {
        baseElevationMm: rack.levels[0]?.elevationMm ?? RACK_PRESET.baseElevationMm,
        beamMm: RACK_PRESET.beamMm,
      }),
    });
  };

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Levels</h4>
        <NumberField label="Number of levels" unit="" min={1} value={rack.levels.length} disabled={disabled} onCommit={setLevelCount} />
        <p className="text-xs text-muted-foreground">Changing the count re-spaces levels evenly within the rack height. Edit rows to fine-tune.</p>
        <div className="space-y-2">
          {rack.levels.map((lv, i) => (
            <div key={i} className="grid grid-cols-[3.5rem_1fr_1fr] items-end gap-2" data-testid={`level-row-${i}`}>
              <span className="pb-2 text-xs font-medium">L{String(levelDisplayNumber(i)).padStart(2, "0")}</span>
              <NumberField
                label="Beam height"
                value={lv.elevationMm}
                disabled={disabled}
                onCommit={(n) => onChange({ levels: rack.levels.map((x, k) => (k === i ? { ...x, elevationMm: n } : x)) })}
              />
              <NumberField
                label="Clearance"
                min={1}
                value={lv.clearanceMm}
                disabled={disabled}
                onCommit={(n) => onChange({ levels: rack.levels.map((x, k) => (k === i ? { ...x, clearanceMm: n } : x)) })}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-sm font-medium">Bays</h4>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Bay width" min={1} value={bayWidth} disabled={disabled} onCommit={setBayWidth} />
          <NumberField label="Positions per bay" unit="" min={1} value={defaultPositions} disabled={disabled} onCommit={setDefaultPositions} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Pallet type</label>
          <select className={selectClass} value={defaultPallet} disabled={disabled} onChange={(e) => setDefaultPallet(e.target.value)}>
            <option value="">None / unspecified</option>
            {palletTypes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.widthMm}×{p.lengthMm})
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange({ bays: suggestBays(rack.lengthMm, bayWidth, { positionCount: defaultPositions, palletTypeId: defaultPallet || null }).bays })}
        >
          Generate bays from rack length
        </Button>
        <p className="text-xs text-muted-foreground" data-testid="bay-summary">
          {rack.bays.length} bays use {formatInt(used)} of {formatInt(rack.lengthMm)} mm
          {used < rack.lengthMm ? ` (${formatInt(rack.lengthMm - used)} mm unallocated)` : ""} · {formatInt(totalPositions(rack))} positions in total
        </p>
        <div className="space-y-2">
          {rack.bays.map((b, j) => (
            <div key={j} className="grid grid-cols-[2.5rem_1fr_4.5rem_auto] items-end gap-2" data-testid={`bay-row-${j}`}>
              <span className="pb-2 text-xs font-medium">B{String(j + 1).padStart(2, "0")}</span>
              <NumberField
                label="Width"
                min={1}
                value={b.widthMm}
                disabled={disabled}
                onCommit={(n) => onChange({ bays: rack.bays.map((x, k) => (k === j ? { ...x, widthMm: n } : x)) })}
              />
              <NumberField
                label="Pos."
                unit=""
                min={1}
                value={b.positionCount}
                disabled={disabled}
                onCommit={(n) => onChange({ bays: rack.bays.map((x, k) => (k === j ? { ...x, positionCount: n } : x)) })}
              />
              <Button type="button" size="sm" variant="ghost" disabled={disabled || rack.bays.length <= 1} aria-label={`Remove bay ${j + 1}`} onClick={() => onChange({ bays: rack.bays.filter((_, k) => k !== j) })}>
                ✕
              </Button>
              <select
                className={`${selectClass} col-span-4`}
                aria-label={`Pallet type for bay ${j + 1}`}
                value={b.palletTypeId ?? ""}
                disabled={disabled}
                onChange={(e) => onChange({ bays: rack.bays.map((x, k) => (k === j ? { ...x, palletTypeId: e.target.value || null } : x)) })}
              >
                <option value="">No pallet type{b.palletTypeId && !palletName(b.palletTypeId) ? " (unknown)" : ""}</option>
                {palletTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange({ bays: [...rack.bays, { widthMm: bayWidth, positionCount: defaultPositions, palletTypeId: defaultPallet || null }] })}
        >
          Add bay
        </Button>
      </section>
    </div>
  );
}

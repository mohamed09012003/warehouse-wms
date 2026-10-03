import { isInsideCanvas } from "@/modules/warehouse/domain/geometry";
import { isValidRackCode } from "@/modules/warehouse/domain/rackCode";
import { validateRackStructure } from "@/modules/warehouse/domain/structure";
import type { PalletTypeDto } from "@/modules/warehouse/types";
import type { DesignerState } from "./designerState";

export interface DraftIssue {
  severity: "error" | "warning";
  /** rack or object id the issue belongs to, if any */
  itemId?: string;
  message: string;
}

/** Same rules the server enforces on save (plus non-blocking warnings), so errors show early. */
export function validateDraft(state: DesignerState, palletTypes: readonly PalletTypeDto[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const { widthMm, lengthMm } = state.warehouse;
  if (!state.warehouse.name.trim()) issues.push({ severity: "error", message: "Warehouse name is required" });
  if (!(widthMm > 0 && lengthMm > 0)) issues.push({ severity: "error", message: "Warehouse dimensions must be greater than 0" });

  const pallets = new Map(palletTypes.map((p) => [p.id, p]));
  const seen = new Map<string, number>();
  for (const r of state.racks) seen.set(r.code, (seen.get(r.code) ?? 0) + 1);

  for (const r of state.racks) {
    const label = `Rack ${r.code || "(no code)"}`;
    if (!isValidRackCode(r.code)) issues.push({ severity: "error", itemId: r.id, message: `${label}: code must be 1-12 capital letters/digits, no hyphen` });
    if ((seen.get(r.code) ?? 0) > 1) issues.push({ severity: "error", itemId: r.id, message: `${label}: code is used more than once` });
    if (!(r.lengthMm > 0 && r.depthMm > 0 && r.heightMm > 0)) {
      issues.push({ severity: "error", itemId: r.id, message: `${label}: dimensions must be greater than 0` });
      continue;
    }
    for (const i of validateRackStructure(r, { levels: r.levels, bays: r.bays }, { palletTypes: pallets })) {
      issues.push({ severity: "error", itemId: r.id, message: `${label}: ${i.message}` });
    }
    if (!isInsideCanvas({ ...r, widthMm: r.lengthMm }, widthMm, lengthMm)) {
      issues.push({ severity: "warning", itemId: r.id, message: `${label} extends outside the warehouse` });
    }
  }
  for (const o of state.objects) {
    if (!(o.widthMm > 0 && o.depthMm > 0)) issues.push({ severity: "error", itemId: o.id, message: "An object has an invalid size" });
  }
  return issues;
}

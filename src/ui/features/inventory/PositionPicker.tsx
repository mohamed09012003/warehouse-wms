"use client";

import { useEffect, useId, useState } from "react";
import { selectClass } from "@/ui/features/warehouse-designer/fields";
import { apiRequest, orgApi } from "@/ui/shared/apiClient";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

export interface PickedPosition {
  id: string;
  code: string;
  warehouseId: string;
}

/**
 * Chooses a physical Position: pick a warehouse, then type its location code (e.g. R01-L01-B03-P02).
 * Suggestions come from the server; the value is only set when the text matches a real position,
 * so the form always submits a real Position id (never a free-form string).
 */
export function PositionPicker({
  orgSlug,
  label,
  warehouses,
  onChange,
  testId,
  initial,
}: {
  orgSlug: string;
  label: string;
  warehouses: { id: string; code: string; name: string }[];
  onChange: (p: PickedPosition | null) => void;
  testId: string;
  initial?: { warehouseId?: string; code?: string };
}) {
  const listId = useId();
  const [warehouseId, setWarehouseId] = useState(initial?.warehouseId ?? warehouses[0]?.id ?? "");
  const [text, setText] = useState(initial?.code ?? "");
  const [options, setOptions] = useState<{ id: string; code: string }[]>([]);

  useEffect(() => {
    if (!warehouseId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiRequest<{ id: string; code: string }[]>(`${orgApi(orgSlug)}/warehouses/${warehouseId}/positions?q=${encodeURIComponent(text)}`)
        .then((rows) => {
          if (cancelled) return;
          setOptions(rows);
          const exact = rows.find((r) => r.code === text.trim().toUpperCase());
          onChange(exact ? { id: exact.id, code: exact.code, warehouseId } : null);
        })
        .catch(() => !cancelled && onChange(null));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // onChange is a state setter from the parent; re-running on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, warehouseId, text]);

  return (
    <div className="space-y-1" data-testid={testId}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        {warehouses.length > 1 && (
          <select className={`${selectClass} w-32`} aria-label={`${label} warehouse`} value={warehouseId} onChange={(e) => {
              onChange(null);
              setWarehouseId(e.target.value);
            }}>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code}
              </option>
            ))}
          </select>
        )}
        <Input
          list={listId}
          aria-label={`${label} location code`}
          placeholder="R01-L01-B01-P01"
          className="h-8 font-mono"
          value={text}
          autoComplete="off"
          onChange={(e) => {
            // Invalidate immediately: the previous pick must not stay submittable while the new text is being resolved.
            onChange(null);
            setText(e.target.value.toUpperCase());
          }}
        />
        <datalist id={listId}>
          {options.map((o) => (
            <option key={o.id} value={o.code} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

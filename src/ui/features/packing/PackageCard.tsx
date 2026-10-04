"use client";

import { useState } from "react";
import type { PackageDto, PackingLineDto } from "@/modules/packing";
import { selectClass } from "@/ui/features/warehouse-designer/fields";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { StatusBadge } from "@/ui/shared/StatusBadge";
import { usePackingAction } from "./usePackingAction";

/** One package: details, contents, and (while OPEN) add / edit / remove / complete / cancel. */
export function PackageCard({
  orgSlug,
  pkg,
  lines,
  editable,
}: {
  orgSlug: string;
  pkg: PackageDto;
  lines: PackingLineDto[];
  editable: boolean;
}) {
  const { run, pending, error } = usePackingAction(orgSlug);
  const open = pkg.status === "OPEN" && editable;
  const addable = lines.filter((l) => l.remainingQty > 0);
  const [lineId, setLineId] = useState("");
  const [qty, setQty] = useState("");
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [details, setDetails] = useState({
    type: pkg.packageType ?? "",
    weight: pkg.weightG?.toString() ?? "",
    l: pkg.lengthMm?.toString() ?? "",
    w: pkg.widthMm?.toString() ?? "",
    h: pkg.heightMm?.toString() ?? "",
  });
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const selected = addable.find((l) => l.orderLineId === lineId) ?? addable[0];

  async function add() {
    if (!selected) return;
    const result = await run(`packages/${pkg.id}/items`, { body: { productCode: selected.sku, orderLineId: selected.orderLineId, quantity: Number(qty) } });
    if (result) setQty("");
  }

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid={`package-${pkg.packageNumber}`} data-status={pkg.status}>
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">Package {pkg.packageNumber}</h3>
        <StatusBadge status={pkg.status} />
        <span className="text-sm text-muted-foreground" data-testid="package-total">
          {pkg.totalQuantity} unit(s)
        </span>
        <span className="text-sm text-muted-foreground" data-testid="package-measures">
          {pkg.packageType ? `${pkg.packageType} · ` : ""}
          {pkg.weightG ? `${pkg.weightG} g` : "weight not set"}
          {pkg.lengthMm ? ` · ${pkg.lengthMm} × ${pkg.widthMm} × ${pkg.heightMm} mm` : " · dimensions not set"}
        </span>
      </div>

      {pkg.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Empty.</p>
      ) : (
        <table className="w-full text-sm" data-testid="package-items">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-3">Product</th>
              <th className="py-1 pr-3 text-right">Quantity</th>
              {open && <th className="py-1" />}
            </tr>
          </thead>
          <tbody>
            {pkg.items.map((i) => (
              <tr key={i.id} className="border-b last:border-0" data-sku={i.sku}>
                <td className="py-1 pr-3">
                  <span className="font-mono">{i.sku}</span> <span className="text-muted-foreground">{i.productName}</span>
                </td>
                <td className="py-1 pr-3 text-right" data-col="quantity">
                  {open ? (
                    <Input
                      className="ml-auto h-7 w-20 text-right"
                      inputMode="numeric"
                      aria-label={`Quantity of ${i.sku} in package ${pkg.packageNumber}`}
                      value={edit[i.id] ?? String(i.quantity)}
                      onChange={(e) => setEdit({ ...edit, [i.id]: e.target.value })}
                    />
                  ) : (
                    i.quantity
                  )}
                </td>
                {open && (
                  <td className="py-1 text-right whitespace-nowrap">
                    <Button type="button" size="sm" variant="outline" disabled={pending || edit[i.id] === undefined || edit[i.id] === String(i.quantity)} onClick={() => run(`items/${i.id}`, { method: "PATCH", body: { quantity: Number(edit[i.id]) } }).then((r) => r && setEdit((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== i.id))))}>
                      Save
                    </Button>{" "}
                    <Button type="button" size="sm" variant="ghost" disabled={pending} aria-label={`Remove ${i.sku} from package ${pkg.packageNumber}`} onClick={() => run(`items/${i.id}`, { method: "DELETE" })}>
                      Remove
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2" aria-label={`Add items to package ${pkg.packageNumber}`}>
            {addable.length === 0 ? (
              <p className="text-sm text-muted-foreground">Everything picked is already in packages.</p>
            ) : (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Product</Label>
                  <select className={`${selectClass} w-64`} aria-label={`Product to add to package ${pkg.packageNumber}`} value={selected?.orderLineId ?? ""} onChange={(e) => setLineId(e.target.value)}>
                    {addable.map((l) => (
                      <option key={l.orderLineId} value={l.orderLineId}>
                        {l.sku} — {l.remainingQty} left to pack
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Quantity</Label>
                  <Input className="h-8 w-24" inputMode="numeric" aria-label={`Quantity to add to package ${pkg.packageNumber}`} value={qty} onChange={(e) => setQty(e.target.value)} />
                </div>
                <Button type="button" size="sm" disabled={pending || qty.trim() === ""} onClick={add}>
                  Add to package
                </Button>
              </>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-6">
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs text-muted-foreground">Package type</Label>
              <Input className="h-8" aria-label={`Type of package ${pkg.packageNumber}`} maxLength={40} value={details.type} onChange={(e) => setDetails({ ...details, type: e.target.value })} />
            </div>
            {(
              [
                ["weight", "Weight (g)"],
                ["l", "Length (mm)"],
                ["w", "Width (mm)"],
                ["h", "Height (mm)"],
              ] as const
            ).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs text-muted-foreground">{label}</Label>
                <Input className="h-8" inputMode="numeric" aria-label={`${label} of package ${pkg.packageNumber}`} value={details[k]} onChange={(e) => setDetails({ ...details, [k]: e.target.value })} />
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(`packages/${pkg.id}`, { method: "PATCH", body: { packageType: details.type.trim() || null, weightG: num(details.weight), lengthMm: num(details.l), widthMm: num(details.w), heightMm: num(details.h) } })}>
              Save details
            </Button>
            <Button type="button" size="sm" disabled={pending} onClick={() => run(`packages/${pkg.id}/complete`)}>
              Complete package
            </Button>
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => run(`packages/${pkg.id}/cancel`)}>
              Cancel package
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid={`package-error-${pkg.packageNumber}`}>
          {error}
        </p>
      )}
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { selectClass } from "@/ui/features/warehouse-designer/fields";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

interface Line {
  productId: string;
  quantity: string;
}

/** Manual (internal) order entry. All validation is repeated and enforced by the server. */
export function CreateOrderForm({ orgSlug, products }: { orgSlug: string; products: { id: string; sku: string; name: string }[] }) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>([{ productId: products[0]?.id ?? "", quantity: "" }]);
  const [ready, setReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (products.length === 0) return <p className="text-sm text-muted-foreground">Create a product first to be able to create orders.</p>;

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const order = await apiRequest<{ id: string }>(`${orgApi(orgSlug)}/orders`, {
        body: {
          orderNumber: f.get("orderNumber"),
          externalRef: (f.get("externalRef") as string) || null,
          note: (f.get("note") as string) || null,
          ready,
          lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })),
        },
      });
      router.push(`/${orgSlug}/orders/${order.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not create the order"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" aria-label="Create order">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="o-number">Order number / reference</Label>
          <Input id="o-number" name="orderNumber" required maxLength={40} placeholder="SO-1001" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="o-ext">External reference (optional)</Label>
          <Input id="o-ext" name="externalRef" maxLength={100} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="o-note">Note (optional)</Label>
          <Input id="o-note" name="note" maxLength={500} />
        </div>
      </div>

      <div className="space-y-2" data-testid="order-lines">
        <Label>Lines</Label>
        {lines.map((line, i) => (
          <div key={i} className="grid grid-cols-[1fr_8rem_auto] items-end gap-2" data-testid={`order-line-${i}`}>
            <select className={selectClass} aria-label={`Product for line ${i + 1}`} value={line.productId} onChange={(e) => update(i, { productId: e.target.value })}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>
            <Input className="h-8" inputMode="numeric" aria-label={`Quantity for line ${i + 1}`} placeholder="Quantity" required value={line.quantity} onChange={(e) => update(i, { quantity: e.target.value })} />
            <Button type="button" size="sm" variant="ghost" disabled={lines.length <= 1} aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>
              ✕
            </Button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => setLines((ls) => [...ls, { productId: products[0].id, quantity: "" }])}>
          Add line
        </Button>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Mark ready for allocation immediately
      </label>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save order"}
      </Button>
    </form>
  );
}

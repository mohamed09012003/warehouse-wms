"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProductDetailDto } from "@/modules/catalog";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

export function ProductEditor({ orgSlug, product, canManage }: { orgSlug: string; product: ProductDetailDto; canManage: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const base = `${orgApi(orgSlug)}/products/${product.id}`;

  async function run(action: () => Promise<unknown>, success: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(
      () => apiRequest(base, { method: "PATCH", body: { name: f.get("name"), description: (f.get("description") as string) || null } }),
      "Product saved",
    );
  }

  async function onAddBarcode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const barcode = new FormData(form).get("barcode");
    await run(async () => {
      await apiRequest(`${base}/barcodes`, { body: { barcode } });
      form.reset();
    }, "Barcode added");
  }

  return (
    <div className="space-y-6">
      <form key={`${product.name}|${product.description}`} onSubmit={onSave} className="grid gap-3 sm:grid-cols-3" aria-label="Edit product">
        <div className="space-y-1">
          <Label htmlFor="e-sku">SKU</Label>
          <Input id="e-sku" value={product.sku} disabled readOnly />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="e-name">Name</Label>
          <Input id="e-name" name="name" defaultValue={product.name} required maxLength={200} disabled={!canManage} />
        </div>
        <div className="space-y-1 sm:col-span-3">
          <Label htmlFor="e-desc">Description</Label>
          <Input id="e-desc" name="description" defaultValue={product.description ?? ""} maxLength={2000} disabled={!canManage} />
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
            <Button type="submit" disabled={pending}>
              Save changes
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => apiRequest(base, { method: "PATCH", body: { active: !product.active } }), product.active ? "Product disabled" : "Product enabled")}
            >
              {product.active ? "Disable product" : "Enable product"}
            </Button>
            <Badge variant={product.active ? "secondary" : "destructive"} data-testid="product-status">
              {product.active ? "Active" : "Disabled"}
            </Badge>
          </div>
        )}
      </form>

      <section className="space-y-3" aria-label="Barcodes">
        <h3 className="font-medium">Barcodes</h3>
        {product.barcodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No barcodes.</p>
        ) : (
          <ul className="divide-y rounded-lg border text-sm" data-testid="barcode-list">
            {product.barcodes.map((b) => (
              <li key={b.id} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono">{b.barcode}</span>
                {canManage && (
                  <Button type="button" size="sm" variant="ghost" disabled={pending} aria-label={`Remove barcode ${b.barcode}`} onClick={() => run(() => apiRequest(`${base}/barcodes/${b.id}`, { method: "DELETE" }), "Barcode removed")}>
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form onSubmit={onAddBarcode} className="flex items-end gap-2" aria-label="Add barcode">
            <div className="flex-1 space-y-1">
              <Label htmlFor="b-code">New barcode</Label>
              <Input id="b-code" name="barcode" required maxLength={128} />
            </div>
            <Button type="submit" disabled={pending}>
              Add barcode
            </Button>
          </form>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="text-sm text-emerald-600">
          {notice}
        </p>
      )}
    </div>
  );
}

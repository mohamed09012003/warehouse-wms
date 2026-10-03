"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

export function CreateProductForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setPending(true);
    setError(null);
    try {
      const p = await apiRequest<{ id: string }>(`${orgApi(orgSlug)}/products`, {
        body: { sku: f.get("sku"), name: f.get("name"), description: f.get("description") || null },
      });
      form.reset();
      router.push(`/${orgSlug}/products/${p.id}`);
    } catch (err) {
      setError(errorMessage(err, "Could not create the product"));
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" aria-label="Create product">
      <div className="space-y-1">
        <Label htmlFor="p-sku">SKU</Label>
        <Input id="p-sku" name="sku" required maxLength={64} placeholder="WIDGET-001" />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="p-name">Name</Label>
        <Input id="p-name" name="name" required maxLength={200} />
      </div>
      <div className="space-y-1 sm:col-span-3">
        <Label htmlFor="p-desc">Description (optional)</Label>
        <Input id="p-desc" name="description" maxLength={2000} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
          {error}
        </p>
      )}
      <div className="sm:col-span-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create product"}
        </Button>
      </div>
    </form>
  );
}

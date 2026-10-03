"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, warehouseApi } from "@/ui/features/warehouse-designer/api";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

export function PalletTypeForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const optional = (key: string) => (f.get(key) ? Number(f.get(key)) : null);
    setPending(true);
    setError(null);
    try {
      await warehouseApi.createPalletType(orgSlug, {
        name: f.get("name"),
        widthMm: Number(f.get("widthMm")),
        lengthMm: Number(f.get("lengthMm")),
        heightMm: optional("heightMm"),
        maxLoadG: optional("maxLoadKg") === null ? null : optional("maxLoadKg")! * 1000,
      });
      form.reset();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the pallet type");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-5" aria-label="Add pallet type">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="pt-name">Name</Label>
        <Input id="pt-name" name="name" required maxLength={120} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pt-w">Width (mm)</Label>
        <Input id="pt-w" name="widthMm" type="number" min={1} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pt-l">Length (mm)</Label>
        <Input id="pt-l" name="lengthMm" type="number" min={1} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pt-h">Height (mm)</Label>
        <Input id="pt-h" name="heightMm" type="number" min={1} placeholder="optional" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pt-load">Max load (kg)</Label>
        <Input id="pt-load" name="maxLoadKg" type="number" min={1} placeholder="optional" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-5">
          {error}
        </p>
      )}
      <div className="sm:col-span-5">
        <Button type="submit" size="sm" disabled={pending}>
          Add pallet type
        </Button>
      </div>
    </form>
  );
}

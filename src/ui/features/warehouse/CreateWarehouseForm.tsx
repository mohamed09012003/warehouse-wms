"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, warehouseApi } from "@/ui/features/warehouse-designer/api";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";

export function CreateWarehouseForm({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    try {
      const wh = await warehouseApi.createWarehouse(orgSlug, {
        code: f.get("code"),
        name: f.get("name"),
        widthMm: Number(f.get("widthMm")),
        lengthMm: Number(f.get("lengthMm")),
      });
      router.push(`/${orgSlug}/warehouse/${wh.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the warehouse");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" aria-label="Create warehouse">
      <div className="space-y-1">
        <Label htmlFor="wh-name">Name</Label>
        <Input id="wh-name" name="name" required maxLength={120} placeholder="Main warehouse" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wh-code">Code</Label>
        <Input id="wh-code" name="code" required maxLength={20} placeholder="MAIN" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wh-width">Width (mm)</Label>
        <Input id="wh-width" name="widthMm" type="number" min={1000} step={1} required defaultValue={40000} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="wh-length">Length (mm)</Label>
        <Input id="wh-length" name="lengthMm" type="number" min={1000} step={1} required defaultValue={30000} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {error}
        </p>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create warehouse"}
        </Button>
      </div>
    </form>
  );
}

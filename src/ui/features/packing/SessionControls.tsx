"use client";

import { useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { usePackingAction } from "./usePackingAction";

/** Complete / cancel the packing session, and create packages. Buttons follow the session's state; the server re-checks. */
export function SessionControls({
  orgSlug,
  sessionId,
  status,
  canComplete,
  canManage,
}: {
  orgSlug: string;
  sessionId: string;
  status: string;
  canComplete: boolean;
  canManage: boolean;
}) {
  const { run, pending, error } = usePackingAction(orgSlug);
  const [type, setType] = useState("");
  const [weight, setWeight] = useState("");
  const [dims, setDims] = useState({ l: "", w: "", h: "" });
  if (!canManage || status !== "OPEN") return null;

  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  async function create() {
    const result = await run(`sessions/${sessionId}/packages`, {
      body: { packageType: type.trim() || null, weightG: num(weight), lengthMm: num(dims.l), widthMm: num(dims.w), heightMm: num(dims.h) },
    });
    if (result) {
      setType("");
      setWeight("");
      setDims({ l: "", w: "", h: "" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-6" aria-label="New package">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="np-type" className="text-xs text-muted-foreground">Package type (optional)</Label>
          <Input id="np-type" className="h-8" maxLength={40} value={type} onChange={(e) => setType(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="np-weight" className="text-xs text-muted-foreground">Weight (g)</Label>
          <Input id="np-weight" className="h-8" inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="np-l" className="text-xs text-muted-foreground">Length (mm)</Label>
          <Input id="np-l" className="h-8" inputMode="numeric" value={dims.l} onChange={(e) => setDims({ ...dims, l: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="np-w" className="text-xs text-muted-foreground">Width (mm)</Label>
          <Input id="np-w" className="h-8" inputMode="numeric" value={dims.w} onChange={(e) => setDims({ ...dims, w: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="np-h" className="text-xs text-muted-foreground">Height (mm)</Label>
          <Input id="np-h" className="h-8" inputMode="numeric" value={dims.h} onChange={(e) => setDims({ ...dims, h: e.target.value })} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Packing actions">
        <Button type="button" variant="secondary" disabled={pending} onClick={create}>
          Create package
        </Button>
        <Button type="button" disabled={pending || !canComplete} onClick={() => run(`sessions/${sessionId}/complete`)} title={canComplete ? undefined : "Pack everything that was picked and complete every package first"}>
          Complete packing
        </Button>
        <Button type="button" variant="destructive" disabled={pending} onClick={() => run(`sessions/${sessionId}/cancel`)}>
          Cancel packing
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="session-error">
          {error}
        </p>
      )}
    </div>
  );
}

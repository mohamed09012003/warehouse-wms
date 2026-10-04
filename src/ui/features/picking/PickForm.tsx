"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { PickResultDto } from "@/modules/picking";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

/**
 * The picker's confirmation form. It sends exactly what a barcode scanner would send: the location
 * code, the SKU/barcode and the quantity. The server decides whether the pick is valid.
 * One Idempotency-Key per attempt, so a double click or a retry consumes stock once.
 */
export function PickForm({
  orgSlug,
  taskId,
  remaining,
  disabled,
  nextTaskHref,
  backHref,
}: {
  orgSlug: string;
  taskId: string;
  remaining: number;
  disabled: boolean;
  nextTaskHref: string | null;
  backHref: string;
}) {
  const router = useRouter();
  const [location, setLocation] = useState("");
  const [product, setProduct] = useState("");
  const [quantity, setQuantity] = useState(String(remaining));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PickResultDto | null>(null);
  const key = useRef("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(null);
    key.current ||= crypto.randomUUID();
    setPending(true);
    try {
      const result = await apiRequest<PickResultDto>(`${orgApi(orgSlug)}/picking/tasks/${taskId}/confirm`, {
        body: { locationCode: location, productCode: product, quantity: Number(quantity) },
        idempotencyKey: key.current,
      });
      key.current = "";
      setDone(result);
      setLocation("");
      setProduct("");
      setQuantity(String(result.task.remainingQty));
      router.refresh();
    } catch (err) {
      key.current = ""; // a rejected attempt can be corrected and sent again as a new request
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" aria-label="Confirm pick">
        <div className="space-y-1">
          <Label htmlFor="pk-loc">1. Confirm location</Label>
          <Input id="pk-loc" className="h-9 font-mono" autoComplete="off" autoFocus placeholder="Scan or type the location code" value={location} onChange={(e) => setLocation(e.target.value.toUpperCase())} disabled={disabled} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pk-prod">2. Confirm product (SKU or barcode)</Label>
          <Input id="pk-prod" className="h-9 font-mono" autoComplete="off" placeholder="Scan or type the SKU" value={product} onChange={(e) => setProduct(e.target.value)} disabled={disabled} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pk-qty">3. Quantity picked</Label>
          <Input id="pk-qty" className="h-9" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={disabled} required />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" size="lg" disabled={disabled || pending}>
            {pending ? "Confirming…" : "Complete pick"}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" data-testid="pick-error">
          {error}
        </p>
      )}
      {done && !error && (
        <div role="status" className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm" data-testid="pick-success">
          <p className="font-medium text-emerald-700">
            {done.task.status === "COMPLETED" ? "Task complete." : `Picked. ${done.task.remainingQty} left on this task.`}
            {done.replayed ? " (This confirmation had already been recorded.)" : ""}
          </p>
          {done.waveStatus === "COMPLETED" && <p>Wave complete: every task is done.</p>}
          {done.orderStatus === "PICKED" && <p>Order {done.task.orderNumber} is fully picked.</p>}
          <div className="flex gap-3">
            {done.task.status === "COMPLETED" && nextTaskHref && (
              <a className="underline" href={nextTaskHref}>
                Next task →
              </a>
            )}
            <a className="underline" href={backHref}>
              Back to wave
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

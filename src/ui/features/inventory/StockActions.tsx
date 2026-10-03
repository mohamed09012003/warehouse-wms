"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { OperationResultDto } from "@/modules/inventory/types";
import { selectClass } from "@/ui/features/warehouse-designer/fields";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";
import { PositionPicker, type PickedPosition } from "./PositionPicker";

type Tab = "receive" | "move" | "adjust" | "reserve";
interface ProductOption {
  id: string;
  sku: string;
  name: string;
}
interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Forms for the stock operations. They only collect input and call the API; all rules
 * (ownership, quantities, available stock) are enforced by the server.
 * Each form attempt carries an Idempotency-Key so a double click or retry is applied once.
 */
export function StockActions({
  orgSlug,
  products,
  warehouses,
  canAdjust,
  canReserve,
}: {
  orgSlug: string;
  products: ProductOption[];
  warehouses: WarehouseOption[];
  canAdjust: boolean;
  canReserve: boolean;
}) {
  const router = useRouter();
  const tabs: { id: Tab; label: string; allowed: boolean }[] = [
    { id: "receive", label: "Receive", allowed: canAdjust },
    { id: "move", label: "Move", allowed: canAdjust },
    { id: "adjust", label: "Adjust", allowed: canAdjust },
    { id: "reserve", label: "Reserve", allowed: canReserve },
  ];
  const visible = tabs.filter((t) => t.allowed);
  const [tab, setTab] = useState<Tab>(visible[0]?.id ?? "receive");
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [from, setFrom] = useState<PickedPosition | null>(null);
  const [to, setTo] = useState<PickedPosition | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const key = useRef<string>("");

  if (visible.length === 0) return <p className="text-sm text-muted-foreground">You can view inventory but not change it.</p>;
  if (products.length === 0) return <p className="text-sm text-muted-foreground">Create a product first.</p>;
  if (warehouses.length === 0) return <p className="text-sm text-muted-foreground">Create a warehouse with racks first.</p>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const qty = Number(quantity);
    const base = `${orgApi(orgSlug)}/inventory`;
    let url = "";
    let body: Record<string, unknown> = {};
    if (tab === "receive") {
      url = `${base}/receive`;
      body = { productId, positionId: from?.id, quantity: qty, reason: reason || undefined };
    } else if (tab === "move") {
      url = `${base}/move`;
      body = { productId, fromPositionId: from?.id, toPositionId: to?.id, quantity: qty, reason: reason || undefined };
    } else if (tab === "adjust") {
      url = `${base}/adjust`;
      body = { productId, positionId: from?.id, delta: direction === "in" ? qty : -qty, reason };
    } else {
      url = `${base}/reservations`;
      body = { lines: [{ productId, positionId: from?.id, quantity: qty }], note: reason || undefined };
    }
    // One key per attempt: reused on retry of the same form state, renewed after success.
    key.current ||= crypto.randomUUID();
    setPending(true);
    try {
      const result = await apiRequest<OperationResultDto>(url, { body, idempotencyKey: key.current });
      key.current = "";
      setNotice(
        `${tab === "reserve" ? "Reserved" : "Done"}: ${result.movements.map((m) => `${m.positionCode} on hand ${m.onHandAfter}, reserved ${m.reservedAfter}`).join("; ")}`,
      );
      setQuantity("");
      setReason("");
      router.refresh();
    } catch (err) {
      key.current = ""; // a failed attempt may be edited and retried as a new request
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1" role="tablist" aria-label="Stock operation">
        {visible.map((t) => (
          <Button key={t.id} type="button" size="sm" role="tab" aria-selected={tab === t.id} variant={tab === t.id ? "default" : "outline"} onClick={() => {
              setTab(t.id);
              setError(null);
              setNotice(null);
              setQuantity("");
              setReason("");
              key.current = "";
            }}>
            {t.label}
          </Button>
        ))}
      </div>

      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label={`${tab} stock`} data-testid={`form-${tab}`}>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="op-product" className="text-xs text-muted-foreground">
            Product
          </Label>
          <select id="op-product" className={selectClass} value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} — {p.name}
              </option>
            ))}
          </select>
        </div>

        <PositionPicker key={`${tab}-from`} orgSlug={orgSlug} warehouses={warehouses} onChange={setFrom} testId="picker-from" label={tab === "move" ? "From location" : "Location"} />
        {tab === "move" && <PositionPicker key="move-to" orgSlug={orgSlug} warehouses={warehouses} onChange={setTo} testId="picker-to" label="To location" />}

        {tab === "adjust" && (
          <div className="space-y-1">
            <Label htmlFor="op-dir" className="text-xs text-muted-foreground">
              Direction
            </Label>
            <select id="op-dir" className={selectClass} value={direction} onChange={(e) => setDirection(e.target.value as "in" | "out")}>
              <option value="in">Increase on hand</option>
              <option value="out">Decrease on hand</option>
            </select>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="op-qty" className="text-xs text-muted-foreground">
            Quantity
          </Label>
          <Input id="op-qty" className="h-8" inputMode="numeric" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="op-reason" className="text-xs text-muted-foreground">
            {tab === "adjust" ? "Reason (required)" : tab === "reserve" ? "Note (optional)" : "Reason (optional)"}
          </Label>
          <Input id="op-reason" className="h-8" required={tab === "adjust"} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive sm:col-span-2">
            {error}
          </p>
        )}
        {notice && !error && (
          <p role="status" className="text-sm text-emerald-600 sm:col-span-2" data-testid="op-notice">
            {notice}
          </p>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending || !from || (tab === "move" && !to)}>
            {pending ? "Working…" : tab === "receive" ? "Receive stock" : tab === "move" ? "Move stock" : tab === "adjust" ? "Apply adjustment" : "Reserve stock"}
          </Button>
          {(!from || (tab === "move" && !to)) && <span className="ml-3 text-xs text-muted-foreground">Enter a valid location code to continue.</span>}
        </div>
      </form>
    </div>
  );
}

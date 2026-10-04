"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ReservationDto } from "@/modules/inventory/types";
import { Button } from "@/ui/primitives/button";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

export function ReservationsPanel({ orgSlug, reservations, canReserve }: { orgSlug: string; reservations: ReservationDto[]; canReserve: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function release(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await apiRequest(`${orgApi(orgSlug)}/inventory/reservations/${id}/release`, { method: "POST", body: {}, idempotencyKey: `release-${id}` });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingId(null);
    }
  }

  if (reservations.length === 0) return <p className="text-sm text-muted-foreground">No active reservations.</p>;
  return (
    <div className="space-y-2">
      <ul className="divide-y rounded-lg border text-sm" data-testid="reservation-list">
        {reservations.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <div>
              {r.lines.map((l) => (
                <div key={`${l.positionId}${l.productId}`}>
                  <span className="font-mono">{l.sku}</span> × {l.quantity} at <span className="font-mono">{l.positionCode}</span>
                </div>
              ))}
              {(r.note || r.refType) && <div className="text-xs text-muted-foreground">{[r.refType && `${r.refType} ${r.refId ?? ""}`, r.note].filter(Boolean).join(" · ")}</div>}
            </div>
            {r.refType === "ORDER_LINE" ? (
              <span className="text-xs text-muted-foreground">Allocated to an order</span>
            ) : canReserve && (
              <Button type="button" size="sm" variant="outline" disabled={pendingId === r.id} onClick={() => release(r.id)}>
                Release
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

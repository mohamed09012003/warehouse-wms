"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AllocationResultDto, OrderActionResultDto } from "@/modules/picking";
import { Button } from "@/ui/primitives/button";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

type Action = "ready" | "allocate" | "release" | "cancel";

/** Buttons for the actions the order's CURRENT status allows. The server re-checks every one of them. */
export function OrderActions({
  orgSlug,
  orderId,
  status,
  hasUnallocated,
  canManageOrders,
  canManagePicking,
}: {
  orgSlug: string;
  orderId: string;
  status: string;
  hasUnallocated: boolean;
  canManageOrders: boolean;
  canManagePicking: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: Action) {
    setPending(action);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<AllocationResultDto & OrderActionResultDto>(`${orgApi(orgSlug)}/orders/${orderId}/${action}`, {
        method: "POST",
        body: {},
        idempotencyKey: crypto.randomUUID(),
      });
      if (action === "allocate") {
        setNotice(
          result.allocationState === "FULL"
            ? `Fully allocated (${result.allocatedTotal} of ${result.requestedTotal}).`
            : `Partially allocated: ${result.allocatedTotal} of ${result.requestedTotal} reserved. The rest waits for stock; allocate again when it arrives.`,
        );
      } else if (action === "release") setNotice(`Allocation released (${result.tasksCancelled} pick task(s) cancelled).`);
      else if (action === "cancel") setNotice("Order cancelled; remaining reservations were released.");
      else setNotice("Order marked ready.");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }

  const canAllocate = canManagePicking && (status === "READY" || status === "PARTIALLY_ALLOCATED" || (status === "PICKING" && hasUnallocated));
  const canRelease = canManagePicking && (status === "ALLOCATED" || status === "PARTIALLY_ALLOCATED");
  const canCancel = canManageOrders && ["DRAFT", "READY", "PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING"].includes(status);
  const canReady = canManageOrders && status === "DRAFT";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Order actions">
        {canReady && (
          <Button type="button" disabled={pending !== null} onClick={() => run("ready")}>
            Mark ready
          </Button>
        )}
        {canAllocate && (
          <Button type="button" disabled={pending !== null} onClick={() => run("allocate")}>
            {pending === "allocate" ? "Allocating…" : "Allocate"}
          </Button>
        )}
        {canRelease && (
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => run("release")}>
            Release allocation
          </Button>
        )}
        {canCancel && (
          <Button type="button" variant="destructive" disabled={pending !== null} onClick={() => run("cancel")}>
            Cancel order
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="text-sm text-emerald-600" data-testid="order-notice">
          {notice}
        </p>
      )}
    </div>
  );
}

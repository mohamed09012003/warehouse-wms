"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EligibleOrderDto } from "@/modules/picking";
import { Button } from "@/ui/primitives/button";
import { apiRequest, errorMessage, orgApi } from "@/ui/shared/apiClient";

/** Creates a DRAFT wave and opens it. */
export function CreateWaveButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setPending(true);
    setError(null);
    try {
      const wave = await apiRequest<{ id: string }>(`${orgApi(orgSlug)}/picking/waves`, { body: {} });
      router.push(`/${orgSlug}/picking/${wave.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button type="button" onClick={create} disabled={pending}>
        {pending ? "Creating…" : "Create wave"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Wave lifecycle buttons, shown according to the wave's current status. The server re-checks each action. */
export function WaveActions({ orgSlug, waveId, status, canManage }: { orgSlug: string; waveId: string; status: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "release" | "start" | "complete" | "cancel") {
    setPending(action);
    setError(null);
    try {
      await apiRequest(`${orgApi(orgSlug)}/picking/waves/${waveId}/${action}`, { method: "POST", body: {} });
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  }
  if (!canManage) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Wave actions">
        {status === "DRAFT" && (
          <Button type="button" disabled={pending !== null} onClick={() => run("release")}>
            Release wave
          </Button>
        )}
        {status === "RELEASED" && (
          <Button type="button" disabled={pending !== null} onClick={() => run("start")}>
            Start picking
          </Button>
        )}
        {status === "IN_PROGRESS" && (
          <Button type="button" disabled={pending !== null} onClick={() => run("complete")}>
            Complete wave
          </Button>
        )}
        {["DRAFT", "RELEASED", "IN_PROGRESS"].includes(status) && (
          <Button type="button" variant="destructive" disabled={pending !== null} onClick={() => run("cancel")}>
            Cancel wave
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Pick allocated orders whose pick tasks are not in a wave yet, and add them to this (DRAFT) wave. */
export function AddOrdersPanel({ orgSlug, waveId, orders }: { orgSlug: string; waveId: string; orders: EligibleOrderDto[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (orders.length === 0) return <p className="text-sm text-muted-foreground">No allocated orders are waiting for a wave. Allocate an order first.</p>;

  async function add() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`${orgApi(orgSlug)}/picking/waves/${waveId}/orders`, { body: { orderIds: selected } });
      setSelected([]);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y rounded-lg border text-sm" data-testid="eligible-orders">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center gap-3 px-3 py-2">
            <input
              type="checkbox"
              id={`el-${o.id}`}
              checked={selected.includes(o.id)}
              onChange={(e) => setSelected((s) => (e.target.checked ? [...s, o.id] : s.filter((x) => x !== o.id)))}
            />
            <label htmlFor={`el-${o.id}`} className="flex-1">
              <span className="font-mono">{o.orderNumber}</span>{" "}
              <span className="text-muted-foreground">
                {o.pendingTaskCount} task(s), {o.pendingQuantity} units · {o.status.toLowerCase().replace("_", " ")}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <Button type="button" disabled={selected.length === 0 || pending} onClick={add}>
        Add selected orders
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

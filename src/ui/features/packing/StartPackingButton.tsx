"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/ui/primitives/button";
import { usePackingAction } from "./usePackingAction";

export function StartPackingButton({ orgSlug, orderId }: { orgSlug: string; orderId: string }) {
  const router = useRouter();
  const { run, pending, error } = usePackingAction(orgSlug);
  async function start() {
    const result = await run("sessions", { body: { orderId } });
    if (result) router.push(`/${orgSlug}/packing/${result.session.id}`);
  }
  return (
    <div className="space-y-1">
      <Button type="button" size="sm" disabled={pending} onClick={start}>
        {pending ? "Starting…" : "Start packing"}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

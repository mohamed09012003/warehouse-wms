"use client";

import { Button } from "@/ui/primitives/button";
import { useIntegrationAction } from "./useIntegrationAction";

/** Queue a rejected/failed/dead inbound event or a failed/dead delivery again. The server checks the state. */
export function ReplayButton({ orgSlug, integrationId, kind, id }: { orgSlug: string; integrationId: string; kind: "inbound-events" | "deliveries"; id: string }) {
  const { run, pending, error } = useIntegrationAction(orgSlug);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(`${integrationId}/${kind}/${id}/replay`)}>
        Replay
      </Button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

import { Badge } from "@/ui/primitives/badge";

const LABELS: Record<string, string> = {
  PARTIALLY_ALLOCATED: "Partially allocated",
  IN_PROGRESS: "In progress",
};

const VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  DRAFT: "outline",
  READY: "secondary",
  PARTIALLY_ALLOCATED: "secondary",
  ALLOCATED: "secondary",
  PICKING: "default",
  PICKED: "default",
  CANCELLED: "destructive",
  RELEASED: "secondary",
  IN_PROGRESS: "default",
  COMPLETED: "default",
  PENDING: "outline",
  // integrations
  HEALTHY: "default",
  DEGRADED: "secondary",
  FAILING: "destructive",
  RECEIVED: "outline",
  PROCESSING: "secondary",
  SUCCEEDED: "default",
  FAILED: "destructive",
  REJECTED: "destructive",
  DEAD: "destructive",
};

/** Human-readable status chip for orders, waves and pick tasks. */
export function StatusBadge({ status }: { status: string }) {
  const label = LABELS[status] ?? status.charAt(0) + status.slice(1).toLowerCase();
  return (
    <Badge variant={VARIANT[status] ?? "secondary"} data-status={status}>
      {label}
    </Badge>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getPickTask, getWave } from "@/modules/picking";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { PickForm } from "@/ui/features/picking/PickForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Pick · WMS" };

export default async function PickTaskPage({ params }: { params: Promise<{ orgSlug: string; taskId: string }> }) {
  const { orgSlug, taskId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) notFound();

  let task;
  try {
    task = await getPickTask(ctx, taskId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canPick = hasPermission(ctx, "picking.manage");
  const wave = task.waveId ? await getWave(ctx, task.waveId) : null;
  const next = wave?.tasks.find((t) => t.id !== task.id && (t.status === "PENDING" || t.status === "IN_PROGRESS"));
  const open = task.status === "PENDING" || task.status === "IN_PROGRESS";
  const pickable = open && task.waveStatus === "IN_PROGRESS" && canPick;
  const backHref = task.waveId ? `/${orgSlug}/picking/${task.waveId}` : `/${orgSlug}/picking`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={backHref} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← {task.waveNumber ? `Wave W-${String(task.waveNumber).padStart(4, "0")}` : "Picking"}
        </Link>
        <h1 className="text-2xl font-semibold">Pick</h1>
        <StatusBadge status={task.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Go to</CardTitle>
          <CardDescription>
            Order <span className="font-mono">{task.orderNumber}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-4 text-center">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Source location</div>
            <div className="font-mono text-3xl font-semibold" data-testid="task-location">
              {task.positionCode}
            </div>
          </div>
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div className="sm:col-span-2">
              <div className="text-muted-foreground">Product</div>
              <div className="font-medium">
                <span className="font-mono" data-testid="task-sku">{task.sku}</span> {task.productName}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">To pick</div>
              <div className="text-xl font-semibold" data-testid="task-quantity">{task.quantity}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Picked / remaining</div>
              <div className="text-xl font-semibold" data-testid="task-progress">
                {task.pickedQty} / {task.remainingQty}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Confirm the pick</CardTitle>
          <CardDescription>
            {!canPick
              ? "You can view this task but not confirm picks."
              : pickable
                ? "Confirm the location and the product, then the quantity. A scanner can fill these fields."
                : task.status === "COMPLETED"
                  ? "This task is complete."
                  : task.status === "CANCELLED"
                    ? "This task was cancelled."
                    : `Wave is ${task.waveStatus ?? "not assigned"}: start picking in the wave first.`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PickForm
            orgSlug={orgSlug}
            taskId={task.id}
            remaining={task.remainingQty}
            disabled={!pickable}
            nextTaskHref={next ? `/${orgSlug}/picking/tasks/${next.id}` : null}
            backHref={backHref}
          />
        </CardContent>
      </Card>
    </div>
  );
}

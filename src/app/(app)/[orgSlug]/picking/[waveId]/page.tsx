import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getWave, listEligibleOrders } from "@/modules/picking";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { AddOrdersPanel, WaveActions } from "@/ui/features/picking/WaveControls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Wave · WMS" };

export default async function WavePage({ params }: { params: Promise<{ orgSlug: string; waveId: string }> }) {
  const { orgSlug, waveId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(waveId)) notFound();

  let wave;
  try {
    wave = await getWave(ctx, waveId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canManage = hasPermission(ctx, "picking.manage");
  const eligible = canManage && wave.status === "DRAFT" ? await listEligibleOrders(ctx) : [];
  const label = `W-${String(wave.number).padStart(4, "0")}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/${orgSlug}/picking`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Waves
        </Link>
        <h1 className="text-2xl font-semibold">
          Wave <span className="font-mono">{label}</span>
        </h1>
        <StatusBadge status={wave.status} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          <CardDescription>{wave.note ?? "Work through the tasks below once the wave is started."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Orders</div>
              <div className="font-medium">{wave.orderCount}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Tasks done</div>
              <div className="font-medium" data-testid="wave-tasks-done">
                {wave.completedTaskCount}/{wave.taskCount}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Picked / planned</div>
              <div className="font-medium">
                {wave.pickedQuantity} / {wave.totalQuantity}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Progress</div>
              <div className="font-medium" data-testid="wave-progress">
                {wave.progressPercent}%
              </div>
            </div>
          </div>
          <WaveActions orgSlug={orgSlug} waveId={wave.id} status={wave.status} canManage={canManage} />
        </CardContent>
      </Card>

      {wave.status === "DRAFT" && canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Add allocated orders</CardTitle>
            <CardDescription>Only orders with allocated stock and pick tasks that are not in a wave yet are eligible.</CardDescription>
          </CardHeader>
          <CardContent>
            <AddOrdersPanel orgSlug={orgSlug} waveId={wave.id} orders={eligible} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pick tasks</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {wave.tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks yet.</p>
          ) : (
            <table className="w-full text-sm" data-testid="wave-tasks-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Location</th>
                  <th className="py-2 pr-4">Product</th>
                  <th className="py-2 pr-4">Order</th>
                  <th className="py-2 pr-4 text-right">Picked / quantity</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {wave.tasks.map((t) => (
                  <tr key={t.id} className="border-b last:border-0" data-location={t.positionCode} data-status={t.status}>
                    <td className="py-2 pr-4 font-mono">{t.positionCode}</td>
                    <td className="py-2 pr-4">
                      <span className="font-mono">{t.sku}</span> <span className="text-muted-foreground">{t.productName}</span>
                    </td>
                    <td className="py-2 pr-4 font-mono">{t.orderNumber}</td>
                    <td className="py-2 pr-4 text-right">
                      {t.pickedQty} / {t.quantity}
                    </td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="py-2 text-right">
                      {(t.status === "PENDING" || t.status === "IN_PROGRESS") && wave.status === "IN_PROGRESS" ? (
                        <Link href={`/${orgSlug}/picking/tasks/${t.id}`} className="font-medium underline-offset-4 hover:underline">
                          Pick
                        </Link>
                      ) : (
                        <Link href={`/${orgSlug}/picking/tasks/${t.id}`} className="text-muted-foreground underline-offset-4 hover:underline">
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

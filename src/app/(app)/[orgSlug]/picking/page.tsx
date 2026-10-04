import Link from "next/link";
import { listWaves } from "@/modules/picking";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { CreateWaveButton } from "@/ui/features/picking/WaveControls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Picking · WMS" };

export default async function PickingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const waves = await listWaves(ctx);
  const canManage = hasPermission(ctx, "picking.manage");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Picking</h1>

      <Card>
        <CardHeader>
          <CardTitle>Waves</CardTitle>
          <CardDescription>A wave groups the pick tasks of allocated orders. Release it, start picking, and work through its tasks.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {waves.length === 0 ? (
            <p className="text-sm text-muted-foreground">No waves yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="wave-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Wave</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Orders</th>
                    <th className="py-2 pr-4 text-right">Tasks</th>
                    <th className="py-2 pr-4 text-right">Picked / planned</th>
                    <th className="py-2">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {waves.map((w) => (
                    <tr key={w.id} className="border-b last:border-0" data-wave={w.number}>
                      <td className="py-2 pr-4 font-mono">
                        <Link href={`/${orgSlug}/picking/${w.id}`} className="underline-offset-4 hover:underline">
                          W-{String(w.number).padStart(4, "0")}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={w.status} />
                      </td>
                      <td className="py-2 pr-4 text-right">{w.orderCount}</td>
                      <td className="py-2 pr-4 text-right">
                        {w.completedTaskCount}/{w.taskCount}
                      </td>
                      <td className="py-2 pr-4 text-right">
                        {w.pickedQuantity} / {w.totalQuantity}
                      </td>
                      <td className="py-2">{w.progressPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canManage && <CreateWaveButton orgSlug={orgSlug} />}
        </CardContent>
      </Card>
    </div>
  );
}

import Link from "next/link";
import { listPackableOrders } from "@/modules/packing";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { StartPackingButton } from "@/ui/features/packing/StartPackingButton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Packing · WMS" };

export default async function PackingPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const orders = await listPackableOrders(ctx);
  const canManage = hasPermission(ctx, "packing.manage");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Packing</h1>

      <Card>
        <CardHeader>
          <CardTitle>Orders to pack</CardTitle>
          <CardDescription>
            Orders with picked quantity, including partially picked ones. Packing records which picked units go into which package; it never changes stock.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders have picked quantity yet. Pick an order first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="packing-queue">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Order</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Requested</th>
                    <th className="py-2 pr-4 text-right">Picked</th>
                    <th className="py-2 pr-4 text-right">Packed</th>
                    <th className="py-2 pr-4 text-right">Remaining</th>
                    <th className="py-2 pr-4 text-right">Packages</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.orderId} className="border-b last:border-0 align-top" data-order={o.orderNumber}>
                      <td className="py-2 pr-4 font-mono">
                        <Link href={`/${orgSlug}/orders/${o.orderId}`} className="underline-offset-4 hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="py-2 pr-4 text-right" data-col="requested">{o.requestedTotal}</td>
                      <td className="py-2 pr-4 text-right" data-col="picked">{o.pickedTotal}</td>
                      <td className="py-2 pr-4 text-right" data-col="packed">{o.packedTotal}</td>
                      <td className="py-2 pr-4 text-right" data-col="remaining">{o.remainingTotal}</td>
                      <td className="py-2 pr-4 text-right" data-col="packages">{o.packageCount}</td>
                      <td className="py-2 text-right">
                        {o.openSessionId ? (
                          <Link href={`/${orgSlug}/packing/${o.openSessionId}`} className="font-medium underline-offset-4 hover:underline">
                            Continue packing
                          </Link>
                        ) : o.canStart && canManage ? (
                          <StartPackingButton orgSlug={orgSlug} orderId={o.orderId} />
                        ) : (
                          <div className="space-y-1 text-xs text-muted-foreground">
                            {o.blockedReason && <div>{o.blockedReason}</div>}
                            {o.lastSessionId && (
                              <Link href={`/${orgSlug}/packing/${o.lastSessionId}`} className="underline-offset-4 hover:underline">
                                View last session
                              </Link>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

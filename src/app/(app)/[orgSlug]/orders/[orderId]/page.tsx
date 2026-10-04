import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getOrder } from "@/modules/orders";
import { listTasksForOrder } from "@/modules/picking";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { OrderActions } from "@/ui/features/orders/OrderActions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Order · WMS" };

const ALLOCATION_LABEL = { NONE: "Not allocated", PARTIAL: "Partially allocated", FULL: "Fully allocated" } as const;

export default async function OrderPage({ params }: { params: Promise<{ orgSlug: string; orderId: string }> }) {
  const { orgSlug, orderId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) notFound();

  let order;
  try {
    order = await getOrder(ctx, orderId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const tasks = hasPermission(ctx, "picking.view") ? await listTasksForOrder(ctx, orderId) : [];
  const hasUnallocated = order.lines.some((l) => l.unallocatedQty > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/${orgSlug}/orders`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Orders
        </Link>
        <h1 className="text-2xl font-semibold">
          Order <span className="font-mono">{order.orderNumber}</span>
        </h1>
        <StatusBadge status={order.status} />
        {order.pickedTotal > 0 && (
          <Link href={`/${orgSlug}/packing`} className="text-sm underline-offset-4 hover:underline">
            Packing →
          </Link>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>
            {order.externalRef ? `External reference ${order.externalRef} · ` : ""}
            {order.note ? `${order.note} · ` : ""}created {order.createdAt.slice(0, 16).replace("T", " ")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-5">
            <div>
              <div className="text-muted-foreground">Allocation</div>
              <div className="font-medium" data-testid="allocation-state">
                {order.status === "DRAFT" || order.status === "CANCELLED" ? "—" : ALLOCATION_LABEL[order.allocationState]}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Requested</div>
              <div className="font-medium">{order.requestedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Allocated</div>
              <div className="font-medium">{order.allocatedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Picked</div>
              <div className="font-medium">{order.pickedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Packed</div>
              <div className="font-medium" data-testid="order-packed-total">{order.packedTotal}</div>
            </div>
          </div>
          <OrderActions
            orgSlug={orgSlug}
            orderId={order.id}
            status={order.status}
            hasUnallocated={hasUnallocated}
            canManageOrders={hasPermission(ctx, "orders.manage")}
            canManagePicking={hasPermission(ctx, "picking.manage")}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="order-lines-table">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4">#</th>
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4 text-right">Requested</th>
                <th className="py-2 pr-4 text-right">Allocated</th>
                <th className="py-2 pr-4 text-right">Picked</th>
                <th className="py-2 pr-4 text-right">Packed</th>
                <th className="py-2 text-right">Not allocated</th>
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id} className="border-b last:border-0" data-sku={l.sku}>
                  <td className="py-2 pr-4">{l.lineNo}</td>
                  <td className="py-2 pr-4">
                    <span className="font-mono">{l.sku}</span> <span className="text-muted-foreground">{l.productName}</span>
                  </td>
                  <td className="py-2 pr-4 text-right" data-col="requested">{l.requestedQty}</td>
                  <td className="py-2 pr-4 text-right" data-col="allocated">{l.allocatedQty}</td>
                  <td className="py-2 pr-4 text-right" data-col="picked">{l.pickedQty}</td>
                  <td className="py-2 pr-4 text-right" data-col="packed">{l.packedQty}</td>
                  <td className="py-2 text-right" data-col="unallocated">{l.unallocatedQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {tasks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pick tasks</CardTitle>
            <CardDescription>Created by allocation: one per reserved position.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="order-tasks-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Location</th>
                  <th className="py-2 pr-4">SKU</th>
                  <th className="py-2 pr-4 text-right">Quantity</th>
                  <th className="py-2 pr-4 text-right">Picked</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Wave</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className="border-b last:border-0" data-location={t.positionCode}>
                    <td className="py-2 pr-4 font-mono">{t.positionCode}</td>
                    <td className="py-2 pr-4 font-mono">{t.sku}</td>
                    <td className="py-2 pr-4 text-right">{t.quantity}</td>
                    <td className="py-2 pr-4 text-right">{t.pickedQty}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="py-2">
                      {t.waveId ? (
                        <Link href={`/${orgSlug}/picking/${t.waveId}`} className="underline-offset-4 hover:underline">
                          W-{String(t.waveNumber).padStart(4, "0")}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">not in a wave</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

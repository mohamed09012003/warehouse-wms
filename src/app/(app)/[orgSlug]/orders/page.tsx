import Link from "next/link";
import { listProducts } from "@/modules/catalog";
import { listOrders } from "@/modules/orders";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { CreateOrderForm } from "@/ui/features/orders/CreateOrderForm";
import { Button } from "@/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { Input } from "@/ui/primitives/input";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Orders · WMS" };

const ALLOCATION_LABEL = { NONE: "Not allocated", PARTIAL: "Partially allocated", FULL: "Fully allocated" } as const;
const STATUSES = ["DRAFT", "READY", "PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING", "PICKED", "CANCELLED"];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const canManage = hasPermission(ctx, "orders.manage");
  const status = STATUSES.includes(query.status ?? "") ? query.status : undefined;
  const [orders, products] = await Promise.all([
    listOrders(ctx, { status, search: query.q?.trim() || undefined }),
    canManage && hasPermission(ctx, "products.view") ? listProducts(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Orders</h1>

      <Card>
        <CardHeader>
          <CardTitle>Orders</CardTitle>
          <CardDescription>Internal orders. Allocate stock on the order page, then pick through a wave.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter orders">
            <Input name="q" defaultValue={query.q ?? ""} placeholder="Order number or reference" className="h-8 max-w-xs" />
            <select name="status" defaultValue={status ?? ""} aria-label="Status" className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm">
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <Button type="submit" size="sm" variant="secondary">
              Filter
            </Button>
          </form>
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="order-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Order</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Lines</th>
                    <th className="py-2 pr-4 text-right">Requested</th>
                    <th className="py-2 pr-4 text-right">Allocated</th>
                    <th className="py-2 pr-4 text-right">Picked</th>
                    <th className="py-2 pr-4">Allocation</th>
                    <th className="py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-b last:border-0" data-order={o.orderNumber}>
                      <td className="py-2 pr-4 font-mono">
                        <Link href={`/${orgSlug}/orders/${o.id}`} className="underline-offset-4 hover:underline">
                          {o.orderNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">
                        <StatusBadge status={o.status} />
                      </td>
                      <td className="py-2 pr-4 text-right">{o.lineCount}</td>
                      <td className="py-2 pr-4 text-right">{o.requestedTotal}</td>
                      <td className="py-2 pr-4 text-right">{o.allocatedTotal}</td>
                      <td className="py-2 pr-4 text-right">{o.pickedTotal}</td>
                      <td className="py-2 pr-4">{o.status === "DRAFT" || o.status === "CANCELLED" ? "—" : ALLOCATION_LABEL[o.allocationState]}</td>
                      <td className="py-2 whitespace-nowrap">{o.createdAt.slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>New order</CardTitle>
            <CardDescription>Manual entry for testing the picking flow. No customers or shipping details yet.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateOrderForm orgSlug={orgSlug} products={products.map((p) => ({ id: p.id, sku: p.sku, name: p.name }))} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

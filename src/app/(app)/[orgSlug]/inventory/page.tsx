import Link from "next/link";
import { listProducts } from "@/modules/catalog";
import { listMovements, listReservations, listStock } from "@/modules/inventory";
import { hasPermission } from "@/modules/tenancy";
import { listWarehouses } from "@/modules/warehouse";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { ReservationsPanel } from "@/ui/features/inventory/ReservationsPanel";
import { StockActions } from "@/ui/features/inventory/StockActions";
import { Button } from "@/ui/primitives/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { Input } from "@/ui/primitives/input";

export const metadata = { title: "Inventory · WMS" };

const uuid = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined);

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ q?: string; warehouseId?: string }>;
}) {
  const { orgSlug } = await params;
  const query = await searchParams;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const canView = hasPermission(ctx, "inventory.view");
  const canAdjust = hasPermission(ctx, "inventory.adjust");
  const canReserve = hasPermission(ctx, "inventory.reserve");

  if (!canView) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <p className="text-sm text-muted-foreground">You do not have permission to view inventory.</p>
      </div>
    );
  }

  const [stock, movements, reservations, warehouses, products] = await Promise.all([
    listStock(ctx, { search: query.q?.trim() || undefined, warehouseId: uuid(query.warehouseId) }),
    listMovements(ctx, { limit: 25 }),
    listReservations(ctx, "ACTIVE"),
    listWarehouses(ctx),
    hasPermission(ctx, "products.view") ? listProducts(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Inventory</h1>

      {(canAdjust || canReserve) && (
        <Card>
          <CardHeader>
            <CardTitle>Stock operations</CardTitle>
            <CardDescription>Locations are real warehouse positions; type a location code such as R01-L01-B03-P02.</CardDescription>
          </CardHeader>
          <CardContent>
            <StockActions
              orgSlug={orgSlug}
              products={products.map((p) => ({ id: p.id, sku: p.sku, name: p.name }))}
              warehouses={warehouses.map((w) => ({ id: w.id, code: w.code, name: w.name }))}
              canAdjust={canAdjust}
              canReserve={canReserve}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Stock</CardTitle>
          <CardDescription>Available = on hand − reserved.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter stock">
            <Input name="q" defaultValue={query.q ?? ""} placeholder="SKU, name or barcode" className="h-8 max-w-xs" />
            {warehouses.length > 1 && (
              <select name="warehouseId" defaultValue={query.warehouseId ?? ""} className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm" aria-label="Warehouse">
                <option value="">All warehouses</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code}
                  </option>
                ))}
              </select>
            )}
            <Button type="submit" size="sm" variant="secondary">
              Filter
            </Button>
          </form>
          {stock.length === 0 ? (
            <p className="text-sm text-muted-foreground">No stock found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="stock-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">Warehouse</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4 text-right">On hand</th>
                    <th className="py-2 pr-4 text-right">Reserved</th>
                    <th className="py-2 text-right">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((s) => (
                    <tr key={s.balanceId} className="border-b last:border-0" data-sku={s.sku} data-location={s.positionCode}>
                      <td className="py-2 pr-4">
                        <Link href={`/${orgSlug}/products/${s.productId}`} className="font-mono underline-offset-4 hover:underline">
                          {s.sku}
                        </Link>{" "}
                        <span className="text-muted-foreground">{s.productName}</span>
                      </td>
                      <td className="py-2 pr-4">{s.warehouseCode}</td>
                      <td className="py-2 pr-4 font-mono">{s.positionCode}</td>
                      <td className="py-2 pr-4 text-right" data-col="onHand">{s.onHand}</td>
                      <td className="py-2 pr-4 text-right" data-col="reserved">{s.reserved}</td>
                      <td className="py-2 text-right font-medium" data-col="available">{s.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active reservations</CardTitle>
        </CardHeader>
        <CardContent>
          <ReservationsPanel orgSlug={orgSlug} reservations={reservations} canReserve={canReserve} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent movements</CardTitle>
          <CardDescription>Append-only history of every quantity change.</CardDescription>
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No movements yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="movement-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">SKU</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4 text-right">Δ on hand</th>
                    <th className="py-2 pr-4 text-right">Δ reserved</th>
                    <th className="py-2 pr-4">By</th>
                    <th className="py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((m) => (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 whitespace-nowrap">{m.createdAt.slice(0, 19).replace("T", " ")}</td>
                      <td className="py-2 pr-4">{m.type}</td>
                      <td className="py-2 pr-4 font-mono">{m.sku}</td>
                      <td className="py-2 pr-4 font-mono">
                        {m.positionCode}
                        {m.counterpartPositionCode ? <span className="text-muted-foreground"> ↔ {m.counterpartPositionCode}</span> : null}
                      </td>
                      <td className="py-2 pr-4 text-right">{m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta}</td>
                      <td className="py-2 pr-4 text-right">{m.reservedDelta > 0 ? `+${m.reservedDelta}` : m.reservedDelta}</td>
                      <td className="py-2 pr-4">{m.actorName ?? ""}</td>
                      <td className="py-2">{m.reason ?? ""}</td>
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

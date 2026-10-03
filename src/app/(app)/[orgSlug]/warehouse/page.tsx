import { formatInt } from "@/lib/format";
import Link from "next/link";
import { hasPermission } from "@/modules/tenancy";
import { listPalletTypes, listWarehouses } from "@/modules/warehouse";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { CreateWarehouseForm } from "@/ui/features/warehouse/CreateWarehouseForm";
import { PalletTypeForm } from "@/ui/features/warehouse/PalletTypeForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export const metadata = { title: "Warehouses · WMS" };

export default async function WarehousesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const [warehouses, palletTypes] = await Promise.all([listWarehouses(ctx), listPalletTypes(ctx)]);
  const canDesign = hasPermission(ctx, "warehouse.design");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Warehouses</h1>

      <Card>
        <CardHeader>
          <CardTitle>Your warehouses</CardTitle>
          <CardDescription>Open a warehouse to view or edit its floor plan.</CardDescription>
        </CardHeader>
        <CardContent>
          {warehouses.length === 0 ? (
            <p className="text-sm text-muted-foreground">No warehouses yet.</p>
          ) : (
            <ul className="divide-y" data-testid="warehouse-list">
              {warehouses.map((w) => (
                <li key={w.id} className="flex items-center justify-between py-3">
                  <div>
                    <Link href={`/${orgSlug}/warehouse/${w.id}`} className="font-medium underline-offset-4 hover:underline">
                      {w.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {w.code} · {formatInt(w.widthMm)} × {formatInt(w.lengthMm)} mm · {w.rackCount} racks · {w.objectCount} other objects
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canDesign && (
        <Card>
          <CardHeader>
            <CardTitle>New warehouse</CardTitle>
            <CardDescription>Dimensions are in millimetres and can be changed later in the designer.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateWarehouseForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pallet types</CardTitle>
          <CardDescription>Your organization&apos;s pallet sizes. Bays reference these to validate how many pallets fit.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {palletTypes.length === 0 ? (
            <p className="text-sm text-muted-foreground">None defined. Bays can still be configured without a pallet type.</p>
          ) : (
            <ul className="divide-y text-sm" data-testid="pallet-type-list">
              {palletTypes.map((p) => (
                <li key={p.id} className="py-2">
                  <span className="font-medium">{p.name}</span> — {p.widthMm} × {p.lengthMm} mm
                  {p.heightMm ? ` × ${p.heightMm} mm` : ""}
                  {p.maxLoadG ? `, max ${p.maxLoadG / 1000} kg` : ""}
                </li>
              ))}
            </ul>
          )}
          {canDesign && <PalletTypeForm orgSlug={orgSlug} />}
        </CardContent>
      </Card>
    </div>
  );
}

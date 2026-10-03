import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { hasPermission } from "@/modules/tenancy";
import { getLayout, listPalletTypes } from "@/modules/warehouse";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { WarehouseDesigner } from "@/ui/features/warehouse-designer/WarehouseDesigner";

export const metadata = { title: "Warehouse designer · WMS" };

export default async function WarehouseDesignerPage({ params }: { params: Promise<{ orgSlug: string; warehouseId: string }> }) {
  const { orgSlug, warehouseId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  // A malformed or foreign id is a 404, never a database error or a cross-tenant read.
  if (!/^[0-9a-f-]{36}$/i.test(warehouseId)) notFound();

  let layout;
  try {
    layout = await getLayout(ctx, warehouseId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const palletTypes = await listPalletTypes(ctx);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/${orgSlug}/warehouse`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Warehouses
        </Link>
        <h1 className="text-2xl font-semibold">Warehouse designer</h1>
      </div>
      <WarehouseDesigner orgSlug={orgSlug} initialLayout={layout} palletTypes={palletTypes} canEdit={hasPermission(ctx, "warehouse.design")} />
    </div>
  );
}

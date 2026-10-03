import Link from "next/link";
import { listProducts } from "@/modules/catalog";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { CreateProductForm } from "@/ui/features/products/CreateProductForm";
import { Badge } from "@/ui/primitives/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export const metadata = { title: "Products · WMS" };

export default async function ProductsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  const products = await listProducts(ctx, { includeInactive: true });
  const canManage = hasPermission(ctx, "products.manage");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Products</h1>

      <Card>
        <CardHeader>
          <CardTitle>Catalog</CardTitle>
          <CardDescription>A product is identified by its SKU, unique within your organization.</CardDescription>
        </CardHeader>
        <CardContent>
          {products.length === 0 ? (
            <p className="text-sm text-muted-foreground">No products yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="product-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">SKU</th>
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Barcodes</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono">
                        <Link href={`/${orgSlug}/products/${p.id}`} className="underline-offset-4 hover:underline">
                          {p.sku}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{p.name}</td>
                      <td className="py-2 pr-4">{p.barcodeCount}</td>
                      <td className="py-2">{p.active ? <Badge variant="secondary">Active</Badge> : <Badge variant="destructive">Disabled</Badge>}</td>
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
            <CardTitle>New product</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateProductForm orgSlug={orgSlug} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getProduct } from "@/modules/catalog";
import { listStock } from "@/modules/inventory";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { ProductEditor } from "@/ui/features/products/ProductEditor";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";

export const metadata = { title: "Product · WMS" };

export default async function ProductPage({ params }: { params: Promise<{ orgSlug: string; productId: string }> }) {
  const { orgSlug, productId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(productId)) notFound();

  let product;
  try {
    product = await getProduct(ctx, productId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const stock = hasPermission(ctx, "inventory.view") ? await listStock(ctx, { productId }) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/${orgSlug}/products`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Products
        </Link>
        <h1 className="text-2xl font-semibold">
          <span className="font-mono">{product.sku}</span> · {product.name}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <ProductEditor orgSlug={orgSlug} product={product} canManage={hasPermission(ctx, "products.manage")} />
        </CardContent>
      </Card>

      {stock && (
        <Card>
          <CardHeader>
            <CardTitle>Stock by location</CardTitle>
            <CardDescription>
              <Link href={`/${orgSlug}/inventory`} className="underline-offset-4 hover:underline">
                Open inventory
              </Link>{" "}
              to receive, move or adjust.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {stock.length === 0 ? (
              <p className="text-sm text-muted-foreground">No stock.</p>
            ) : (
              <table className="w-full text-sm" data-testid="product-stock">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2">Location</th>
                    <th className="py-2 text-right">On hand</th>
                    <th className="py-2 text-right">Reserved</th>
                    <th className="py-2 text-right">Available</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((s) => (
                    <tr key={s.balanceId} className="border-b last:border-0">
                      <td className="py-2 font-mono">{s.positionCode}</td>
                      <td className="py-2 text-right">{s.onHand}</td>
                      <td className="py-2 text-right">{s.reserved}</td>
                      <td className="py-2 text-right">{s.available}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { getPackingSession } from "@/modules/packing";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { PackageCard } from "@/ui/features/packing/PackageCard";
import { SessionControls } from "@/ui/features/packing/SessionControls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Packing session · WMS" };

export default async function PackingSessionPage({ params }: { params: Promise<{ orgSlug: string; sessionId: string }> }) {
  const { orgSlug, sessionId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) notFound();

  let session;
  try {
    session = await getPackingSession(ctx, sessionId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canManage = hasPermission(ctx, "packing.manage");
  const editable = canManage && session.status === "OPEN";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/${orgSlug}/packing`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Packing
        </Link>
        <h1 className="text-2xl font-semibold">
          Packing order <span className="font-mono">{session.orderNumber}</span>
        </h1>
        <span data-testid="session-status"><StatusBadge status={session.status} /></span>
        <span className="text-sm text-muted-foreground">order</span>
        <span data-testid="order-status"><StatusBadge status={session.orderStatus} /></span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Progress</CardTitle>
          <CardDescription>
            Only picked units can be packed. {session.requestedTotal > session.pickedTotal ? `${session.requestedTotal - session.pickedTotal} unit(s) of this order are not picked yet and are not part of this packing.` : "Everything requested has been picked."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-muted-foreground">Requested</div>
              <div className="font-medium">{session.requestedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Picked</div>
              <div className="font-medium" data-testid="picked-total">{session.pickedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Packed</div>
              <div className="font-medium" data-testid="packed-total">{session.packedTotal}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Left to pack</div>
              <div className="font-medium" data-testid="remaining-total">{session.remainingTotal}</div>
            </div>
          </div>
          <table className="w-full text-sm" data-testid="packing-lines">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4">Product</th>
                <th className="py-2 pr-4 text-right">Requested</th>
                <th className="py-2 pr-4 text-right">Picked</th>
                <th className="py-2 pr-4 text-right">Packed</th>
                <th className="py-2 text-right">Left to pack</th>
              </tr>
            </thead>
            <tbody>
              {session.lines.map((l) => (
                <tr key={l.orderLineId} className="border-b last:border-0" data-sku={l.sku}>
                  <td className="py-2 pr-4">
                    <span className="font-mono">{l.sku}</span> <span className="text-muted-foreground">{l.productName}</span>
                  </td>
                  <td className="py-2 pr-4 text-right" data-col="requested">{l.requestedQty}</td>
                  <td className="py-2 pr-4 text-right" data-col="picked">{l.pickedQty}</td>
                  <td className="py-2 pr-4 text-right" data-col="packed">{l.packedQty}</td>
                  <td className="py-2 text-right" data-col="remaining">{l.remainingQty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <SessionControls orgSlug={orgSlug} sessionId={session.id} status={session.status} canComplete={session.canComplete} canManage={canManage} />
        </CardContent>
      </Card>

      <section className="space-y-3" aria-label="Packages">
        <h2 className="text-lg font-semibold">Packages</h2>
        {session.packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No packages yet. Create the first package above.</p>
        ) : (
          session.packages.map((p) => <PackageCard key={p.id} orgSlug={orgSlug} pkg={p} lines={session.lines} editable={editable} />)
        )}
      </section>
    </div>
  );
}

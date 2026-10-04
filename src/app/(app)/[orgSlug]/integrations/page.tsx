import Link from "next/link";
import { listIntegrations, listProviders } from "@/integrations";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { CreateIntegrationForm } from "@/ui/features/integrations/CreateIntegrationForm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";

export const metadata = { title: "Integrations · WMS" };

const stamp = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");

export default async function IntegrationsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!hasPermission(ctx, "integrations.view")) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">You do not have access to integrations.</p>
      </div>
    );
  }
  const integrations = await listIntegrations(ctx);
  const canManage = hasPermission(ctx, "integrations.manage");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            External systems exchange events with the WMS here. The WMS stays the source of truth; an external system being offline never stops receiving, moving, picking or packing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {integrations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No integrations yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="integrations-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Provider</th>
                    <th className="py-2 pr-4">Direction</th>
                    <th className="py-2 pr-4">State</th>
                    <th className="py-2 pr-4">Inbound health</th>
                    <th className="py-2 pr-4">Outbound health</th>
                    <th className="py-2">Last success (in / out)</th>
                  </tr>
                </thead>
                <tbody>
                  {integrations.map((i) => (
                    <tr key={i.id} className="border-b last:border-0" data-integration={i.name}>
                      <td className="py-2 pr-4">
                        <Link href={`/${orgSlug}/integrations/${i.id}`} className="underline-offset-4 hover:underline">
                          {i.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{i.providerLabel}</td>
                      <td className="py-2 pr-4">{[i.inboundEnabled && "In", i.outboundEnabled && "Out"].filter(Boolean).join(" / ") || "—"}</td>
                      <td className="py-2 pr-4" data-col="enabled">
                        {i.archivedAt ? "Archived" : i.enabled ? (i.outboundPausedAt ? "Enabled (paused)" : "Enabled") : "Disabled"}
                      </td>
                      <td className="py-2 pr-4" data-col="inbound-health">
                        {i.inboundEnabled ? <StatusBadge status={i.inbound.healthStatus} /> : "—"}
                      </td>
                      <td className="py-2 pr-4" data-col="outbound-health">
                        {i.outboundEnabled ? <StatusBadge status={i.outbound.healthStatus} /> : "—"}
                        {i.outboundPausedAt && <span className="ml-2 text-xs text-destructive">paused</span>}
                      </td>
                      <td className="py-2" data-col="last-success">
                        {i.inboundEnabled ? stamp(i.inbound.lastSuccessAt) : "—"} / {i.outboundEnabled ? stamp(i.outbound.lastSuccessAt) : "—"}
                      </td>
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
            <CardTitle>New integration</CardTitle>
            <CardDescription>Created disabled. Add configuration and secrets, then enable it.</CardDescription>
          </CardHeader>
          <CardContent>
            <CreateIntegrationForm orgSlug={orgSlug} providers={listProviders().map((p) => ({ provider: p.provider, label: p.label }))} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

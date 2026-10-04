import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getIntegration,
  listDeliveries,
  listInboundEvents,
  listIntegrationLogs,
} from "@/integrations";
import { NotFoundError } from "@/lib/errors";
import { OUTBOX_EVENT_TYPES } from "@/modules/outbox";
import { hasPermission } from "@/modules/tenancy";
import { tenantContextOrRedirect } from "@/server/auth/guards";
import { ConfigForm } from "@/ui/features/integrations/ConfigForm";
import { IntegrationControls } from "@/ui/features/integrations/IntegrationControls";
import { ReplayButton } from "@/ui/features/integrations/ReplayButton";
import { SecretsPanel } from "@/ui/features/integrations/SecretsPanel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/primitives/card";
import { StatusBadge } from "@/ui/shared/StatusBadge";
import type { DirectionHealthDto } from "@/integrations/types";

export const metadata = { title: "Integration · WMS" };

const stamp = (iso: string | null) => (iso ? iso.slice(0, 19).replace("T", " ") : "—");

/** One direction's health, independent of the other (inbound and outbound are tracked separately). */
function HealthBlock({ direction, enabled, health, paused }: { direction: "inbound" | "outbound"; enabled: boolean; health: DirectionHealthDto; paused?: boolean }) {
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm" data-testid={`health-${direction}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium capitalize">{direction}</span>
        {enabled ? <StatusBadge status={health.healthStatus} /> : <span className="text-muted-foreground">not used</span>}
        {paused && (
          <span className="text-destructive" data-testid="outbound-paused">
            delivery paused
          </span>
        )}
      </div>
      <div className="text-muted-foreground">
        Last success <span data-testid={`${direction}-last-success`}>{stamp(health.lastSuccessAt)}</span> · last failure {stamp(health.lastFailureAt)} · consecutive failures{" "}
        <span data-testid={`${direction}-consecutive-failures`}>{health.consecutiveFailures}</span>
      </div>
      {health.lastErrorSummary && <div className="text-muted-foreground">Last error: {health.lastErrorSummary}</div>}
    </div>
  );
}

export default async function IntegrationPage({ params }: { params: Promise<{ orgSlug: string; integrationId: string }> }) {
  const { orgSlug, integrationId } = await params;
  const ctx = await tenantContextOrRedirect(orgSlug);
  if (!/^[0-9a-f-]{36}$/i.test(integrationId) || !hasPermission(ctx, "integrations.view")) notFound();

  let integration;
  try {
    integration = await getIntegration(ctx, integrationId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canManage = hasPermission(ctx, "integrations.manage");
  const [inbound, deliveries, logs] = await Promise.all([
    listInboundEvents(ctx, integrationId, { limit: 25 }),
    listDeliveries(ctx, integrationId, { limit: 25 }),
    listIntegrationLogs(ctx, integrationId, { limit: 40 }),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/${orgSlug}/integrations`} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          ← Integrations
        </Link>
        <h1 className="text-2xl font-semibold">{integration.name}</h1>
        <span className="text-sm text-muted-foreground" data-testid="enabled-state">
          {integration.archivedAt ? "Archived" : integration.enabled ? (integration.outboundPausedAt ? "Enabled (paused)" : "Enabled") : "Disabled"}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>
            {integration.providerLabel} · inbound endpoint{" "}
            <code className="font-mono" data-testid="webhook-path">{integration.webhookPath}</code> (POST, signed with X-WMS-Signature)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <HealthBlock direction="inbound" enabled={integration.inboundEnabled} health={integration.inbound} />
            <HealthBlock direction="outbound" enabled={integration.outboundEnabled} health={integration.outbound} paused={!!integration.outboundPausedAt} />
          </div>
          <p className="text-sm text-muted-foreground">
            Acts with permissions: <span className="font-medium">{integration.grants.join(", ") || "none"}</span>
          </p>
          <IntegrationControls orgSlug={orgSlug} integration={integration} canManage={canManage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Non-secret settings only. Secrets are write-only (below).</CardDescription>
        </CardHeader>
        <CardContent>
          <ConfigForm orgSlug={orgSlug} integration={integration} eventTypes={OUTBOX_EVENT_TYPES} canManage={canManage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Secrets</CardTitle>
          <CardDescription>Stored encrypted; a value can be replaced but never read back.</CardDescription>
        </CardHeader>
        <CardContent>
          <SecretsPanel orgSlug={orgSlug} integrationId={integration.id} secrets={integration.secrets} canManage={canManage} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inbound events</CardTitle>
          <CardDescription>Received from the external system and processed by the worker.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {inbound.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events received yet.</p>
          ) : (
            <table className="w-full text-sm" data-testid="inbound-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Received</th>
                  <th className="py-2 pr-4">Type</th>
                  <th className="py-2 pr-4">Event id</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4 text-right">Attempts</th>
                  <th className="py-2 pr-4">Result</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {inbound.map((e) => (
                  <tr key={e.id} className="border-b last:border-0 align-top" data-event={e.externalEventId} data-status={e.status}>
                    <td className="py-2 pr-4">{stamp(e.receivedAt)}</td>
                    <td className="py-2 pr-4 font-mono">{e.eventType}</td>
                    <td className="py-2 pr-4 font-mono">{e.externalEventId}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={e.status} />
                    </td>
                    <td className="py-2 pr-4 text-right">{e.attempts}</td>
                    <td className="py-2 pr-4 text-muted-foreground" data-col="result">
                      {e.lastErrorSummary ? `${e.lastErrorCode}: ${e.lastErrorSummary}` : e.resultType ? `${e.resultType}` : ""}
                    </td>
                    <td className="py-2 text-right">
                      {canManage && ["REJECTED", "FAILED", "DEAD"].includes(e.status) && <ReplayButton orgSlug={orgSlug} integrationId={integration.id} kind="inbound-events" id={e.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outbound deliveries</CardTitle>
          <CardDescription>WMS events sent to the target, at least once. Consumers dedupe by event id.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet.</p>
          ) : (
            <table className="w-full text-sm" data-testid="deliveries-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Created</th>
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4 text-right">Attempts</th>
                  <th className="py-2 pr-4 text-right">HTTP</th>
                  <th className="py-2 pr-4">Error</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id} className="border-b last:border-0 align-top" data-event-type={d.eventType} data-status={d.status}>
                    <td className="py-2 pr-4">{stamp(d.createdAt)}</td>
                    <td className="py-2 pr-4 font-mono">{d.eventType}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="py-2 pr-4 text-right">{d.attempts}</td>
                    <td className="py-2 pr-4 text-right">{d.lastHttpStatus ?? "—"}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{d.lastErrorSummary ? `${d.lastErrorCode}: ${d.lastErrorSummary}` : ""}</td>
                    <td className="py-2 text-right">
                      {canManage && ["DEAD", "FAILED"].includes(d.status) && <ReplayButton orgSlug={orgSlug} integrationId={integration.id} kind="deliveries" id={d.id} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Log</CardTitle>
          <CardDescription>Append-only safe summaries: no credentials, headers or payloads.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
          ) : (
            <table className="w-full text-sm" data-testid="logs-table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Direction</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Event</th>
                  <th className="py-2 pr-4 text-right">Attempt</th>
                  <th className="py-2 pr-4 text-right">HTTP</th>
                  <th className="py-2">Summary</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id} className="border-b last:border-0 align-top" data-log-status={l.status}>
                    <td className="py-2 pr-4">{stamp(l.createdAt)}</td>
                    <td className="py-2 pr-4">{l.direction}</td>
                    <td className="py-2 pr-4 font-mono">{l.status}</td>
                    <td className="py-2 pr-4 font-mono">{l.eventType ?? "—"}</td>
                    <td className="py-2 pr-4 text-right">{l.attempt}</td>
                    <td className="py-2 pr-4 text-right">{l.httpStatus ?? "—"}</td>
                    <td className="py-2 text-muted-foreground">{l.safeSummary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

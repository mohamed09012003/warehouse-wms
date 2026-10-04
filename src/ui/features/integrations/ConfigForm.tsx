"use client";

import { useState } from "react";
import type { IntegrationDto } from "@/integrations/types";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { useIntegrationAction } from "./useIntegrationAction";

/** Non-secret configuration of a generic-webhook integration. Secrets have their own panel and are never part of this form. */
export function ConfigForm({
  orgSlug,
  integration,
  eventTypes,
  canManage,
}: {
  orgSlug: string;
  integration: IntegrationDto;
  eventTypes: readonly string[];
  canManage: boolean;
}) {
  const { run, pending, error } = useIntegrationAction(orgSlug);
  const cfg = integration.config as { targetUrl?: string; subscribedEvents?: string[]; maxAttempts?: number };
  const [name, setName] = useState(integration.name);
  const [inbound, setInbound] = useState(integration.inboundEnabled);
  const [outbound, setOutbound] = useState(integration.outboundEnabled);
  const [targetUrl, setTargetUrl] = useState(cfg.targetUrl ?? "");
  const [events, setEvents] = useState<string[]>(cfg.subscribedEvents ?? []);
  const [maxAttempts, setMaxAttempts] = useState(cfg.maxAttempts ? String(cfg.maxAttempts) : "");
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const config: Record<string, unknown> = { subscribedEvents: events };
    if (targetUrl.trim()) config.targetUrl = targetUrl.trim();
    if (maxAttempts.trim()) config.maxAttempts = Number(maxAttempts);
    const result = await run(integration.id, { method: "PATCH", body: { name, inboundEnabled: inbound, outboundEnabled: outbound, config } });
    if (result) setSaved(true);
  }

  const toggle = (type: string) => setEvents((cur) => (cur.includes(type) ? cur.filter((t) => t !== type) : [...cur, type]));

  return (
    <form onSubmit={save} className="grid gap-3 sm:grid-cols-2" aria-label="Integration configuration">
      <div className="space-y-1">
        <Label htmlFor="c-name">Name</Label>
        <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canManage} />
      </div>
      <div className="flex items-end gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={inbound} onChange={(e) => setInbound(e.target.checked)} disabled={!canManage} name="inbound" /> Inbound
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={outbound} onChange={(e) => setOutbound(e.target.checked)} disabled={!canManage} name="outbound" /> Outbound
        </label>
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="c-url">Target URL (outbound; https, no credentials or query string)</Label>
        <Input id="c-url" value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} maxLength={500} placeholder="https://example.com/wms-events" disabled={!canManage} />
      </div>
      <fieldset className="space-y-1 sm:col-span-2">
        <legend className="text-sm font-medium">Events sent to the target</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {eventTypes.map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input type="checkbox" checked={events.includes(t)} onChange={() => toggle(t)} disabled={!canManage} name={`event-${t}`} /> {t}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label htmlFor="c-max">Max attempts (1-12, default 8)</Label>
        <Input id="c-max" inputMode="numeric" value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} disabled={!canManage} />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2" data-testid="config-error">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="text-sm sm:col-span-2" data-testid="config-saved">
          Configuration saved.
        </p>
      )}
      {canManage && (
        <div className="sm:col-span-2">
          <Button type="submit" disabled={pending}>
            Save configuration
          </Button>
        </div>
      )}
    </form>
  );
}

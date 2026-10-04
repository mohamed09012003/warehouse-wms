"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IntegrationDto } from "@/integrations/types";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { useIntegrationAction } from "./useIntegrationAction";

export function CreateIntegrationForm({ orgSlug, providers }: { orgSlug: string; providers: { provider: string; label: string }[] }) {
  const router = useRouter();
  const { run, pending, error } = useIntegrationAction(orgSlug);
  const [inbound, setInbound] = useState(true);
  const [outbound, setOutbound] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const created = await run<IntegrationDto>("", {
      body: { name: f.get("name"), provider: f.get("provider"), inboundEnabled: inbound, outboundEnabled: outbound },
      refresh: false,
    });
    if (created) router.push(`/${orgSlug}/integrations/${created.id}`);
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3" aria-label="Create integration">
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor="i-name">Name</Label>
        <Input id="i-name" name="name" required maxLength={80} placeholder="ERP connection" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="i-provider">Provider</Label>
        <select id="i-provider" name="provider" className="h-9 w-full rounded-md border bg-background px-2 text-sm">
          {providers.map((p) => (
            <option key={p.provider} value={p.provider}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-4 text-sm sm:col-span-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={inbound} onChange={(e) => setInbound(e.target.checked)} name="inbound" /> Receive events (inbound)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={outbound} onChange={(e) => setOutbound(e.target.checked)} name="outbound" /> Send events (outbound)
        </label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive sm:col-span-3">
          {error}
        </p>
      )}
      <div className="sm:col-span-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create integration"}
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useState } from "react";
import type { SecretMetaDto } from "@/integrations/types";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { useIntegrationAction } from "./useIntegrationAction";

const LABELS: Record<string, string> = {
  inbound_signing_secret: "Inbound signing secret (the external system signs what it sends to us)",
  outbound_signing_secret: "Outbound signing secret (we sign what we send to the external system)",
};

/** Browser-side random secret (256 bits, base64url). It never touches the server except as the value you save. */
function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function SecretRow({ orgSlug, integrationId, secret, canManage }: { orgSlug: string; integrationId: string; secret: SecretMetaDto; canManage: boolean }) {
  const { run, pending, error } = useIntegrationAction(orgSlug);
  const [value, setValue] = useState("");
  // A generated value is shown ONCE, in this browser tab only, so it can be copied to the sender.
  const [generated, setGenerated] = useState<string | null>(null);
  // Only a value generated here is ever displayed again; a value you typed is never echoed back.
  const [candidate, setCandidate] = useState<string | null>(null);
  const path = `${integrationId}/secrets/${secret.name}`;

  async function save() {
    const saved = await run(path, { method: "PUT", body: { value } });
    if (saved) {
      if (candidate !== null && candidate === value) setGenerated(value);
      setCandidate(null);
      setValue("");
    }
  }

  return (
    <div className="space-y-2 border-b pb-3 last:border-0" data-secret={secret.name}>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium">{LABELS[secret.name] ?? secret.name}</span>
        <span data-testid={`secret-state-${secret.name}`} className={secret.isSet ? "" : "text-muted-foreground"}>
          {secret.isSet ? `Set${secret.rotatedAt ? ` · rotated ${secret.rotatedAt.slice(0, 16).replace("T", " ")} UTC` : ""}` : "Not set"}
        </span>
        {secret.hasPrevious && <span className="text-xs text-muted-foreground">previous value still accepted for 24 h</span>}
      </div>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            aria-label={`New value for ${secret.name}`}
            className="max-w-sm"
            placeholder={secret.isSet ? "Enter a new value to rotate" : "Enter a value (min. 16 characters)"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button type="button" variant="outline" disabled={pending} onClick={() => {
              const g = generateSecret();
              setValue(g);
              setCandidate(g);
            }}
          >
            Generate
          </Button>
          <Button type="button" disabled={pending || value.length < 16} onClick={save}>
            Save
          </Button>
          {secret.isSet && (
            <Button type="button" variant="destructive" disabled={pending} onClick={() => run(path, { method: "DELETE" })}>
              Remove
            </Button>
          )}
        </div>
      )}
      {generated && (
        <p role="status" className="rounded-md border p-2 text-xs" data-testid={`secret-once-${secret.name}`}>
          Saved. Copy this value into the other system now; it is not shown again:{" "}
          <code className="break-all font-mono">{generated}</code>{" "}
          <button type="button" className="underline" onClick={() => setGenerated(null)}>
            Hide
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Write-only secrets: the server only ever reports whether a secret is set and when it was rotated. */
export function SecretsPanel({ orgSlug, integrationId, secrets, canManage }: { orgSlug: string; integrationId: string; secrets: SecretMetaDto[]; canManage: boolean }) {
  return (
    <div className="space-y-3" data-testid="secrets-panel">
      {secrets.map((s) => (
        <SecretRow key={s.name} orgSlug={orgSlug} integrationId={integrationId} secret={s} canManage={canManage} />
      ))}
    </div>
  );
}

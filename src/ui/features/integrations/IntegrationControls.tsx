"use client";

import { useState } from "react";
import type { IntegrationDto, TestResultDto } from "@/integrations/types";
import { Button } from "@/ui/primitives/button";
import { useIntegrationAction } from "./useIntegrationAction";

/** Enable / disable / resume and the connection test. The server decides what is allowed and why not. */
export function IntegrationControls({ orgSlug, integration, canManage }: { orgSlug: string; integration: IntegrationDto; canManage: boolean }) {
  const { run, pending, error } = useIntegrationAction(orgSlug);
  const [test, setTest] = useState<TestResultDto | null>(null);
  const base = integration.id;
  if (!canManage) return null;
  const archived = !!integration.archivedAt;

  async function runTest() {
    setTest(null);
    const result = await run<TestResultDto>(`${base}/test`);
    if (result) setTest(result);
  }

  return (
    <div className="space-y-3">
      {integration.outboundPausedAt && (
        <p role="status" className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-sm" data-testid="paused-banner">
          Outbound delivery is paused after repeated failures. Pending deliveries are kept. Fix the target, then press Resume.
        </p>
      )}
      {!integration.enabled && integration.readinessProblems.length > 0 && !archived && (
        <ul className="list-disc pl-5 text-sm text-muted-foreground" data-testid="readiness-problems">
          {integration.readinessProblems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Integration actions">
        {!integration.enabled && !archived && (
          <Button type="button" disabled={pending} onClick={() => run(`${base}/enable`)}>
            Enable
          </Button>
        )}
        {integration.enabled && integration.outboundPausedAt && (
          <Button type="button" disabled={pending} onClick={() => run(`${base}/enable`)}>
            Resume
          </Button>
        )}
        {integration.enabled && (
          <Button type="button" variant="secondary" disabled={pending} onClick={() => run(`${base}/disable`, { body: {} })}>
            Disable
          </Button>
        )}
        {integration.outboundEnabled && !archived && (
          <Button type="button" variant="outline" disabled={pending} onClick={runTest}>
            Send test event
          </Button>
        )}
      </div>
      {test && (
        <p role="status" className={test.ok ? "text-sm" : "text-sm text-destructive"} data-testid="test-result">
          {test.ok ? "Test event delivered" : "Test failed"}: {test.summary}
          {test.httpStatus ? ` (HTTP ${test.httpStatus})` : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="controls-error">
          {error}
        </p>
      )}
    </div>
  );
}

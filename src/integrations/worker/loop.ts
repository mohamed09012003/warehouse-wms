// The long-running worker: runOnce() repeatedly, sleeping when idle, purging every few minutes.
// No scheduler or extra infrastructure: this is just a loop around PostgreSQL claiming.
import { logSafe } from "../core/logger";
import { defaultWorkerDeps } from "../service/workerDeps";
import { runOnce, type RunSummary } from "./runOnce";

const PURGE_EVERY_MS = 10 * 60 * 1000;

const busy = (s: RunSummary) =>
  s.reapedInbound + s.reapedDeliveries + s.fannedOutEvents + Object.values(s.inbound).reduce((a, b) => a + b, 0) + Object.values(s.deliveries).reduce((a, b) => a + b, 0);

export async function runWorkerLoop(options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 2000;
  const deps = defaultWorkerDeps();
  let lastPurge = 0;
  while (!options.signal?.aborted) {
    let worked = 0;
    try {
      const purge = Date.now() - lastPurge >= PURGE_EVERY_MS;
      const summary = await runOnce(deps, { purge });
      if (purge) lastPurge = Date.now();
      worked = busy(summary);
    } catch (error) {
      logSafe("error", "worker.pass_failed", { code: error instanceof Error ? error.name : "ERROR" });
    }
    if (worked === 0) await new Promise((resolve) => setTimeout(resolve, pollMs + Math.random() * 250));
  }
}

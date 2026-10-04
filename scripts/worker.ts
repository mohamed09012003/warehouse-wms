// `npm run worker`          - the integration worker: inbound processing, outbox fan-out, outbound delivery,
//                             lease recovery and retention, in a loop until stopped (Ctrl+C / SIGTERM).
// `npm run worker -- --once` - a single pass, then exit (cron-style use, demos, scripts).
// It works on whatever DATABASE_URL points at; it logs the database NAME only, never the URL.
import { databaseNameFromUrl } from "../src/server/db/safety";
import { runOnce, runWorkerLoop } from "../src/integrations";
import { getKeyring } from "../src/integrations/secrets/vault";

async function main() {
  try {
    getKeyring();
  } catch {
    console.error("INTEGRATION_ENCRYPTION_KEYS is not configured (see .env.example). The worker needs the secret vault.");
    process.exit(1);
  }
  const dbName = databaseNameFromUrl(process.env.DATABASE_URL);
  if (process.argv.includes("--once")) {
    const summary = await runOnce(undefined, { purge: true });
    console.log(JSON.stringify({ event: "worker.once", database: dbName, ...summary }));
    process.exit(0);
  }
  console.log(JSON.stringify({ event: "worker.start", database: dbName }));
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
  await runWorkerLoop({ signal: controller.signal });
  console.log(JSON.stringify({ event: "worker.stop" }));
  process.exit(0);
}

main().catch((error) => {
  console.error(JSON.stringify({ event: "worker.crashed", errorClass: error instanceof Error ? error.name : "Error" }));
  process.exit(1);
});

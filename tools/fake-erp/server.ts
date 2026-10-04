// FAKE ERP (development tool). Start with:  npm run fake-erp
// Binds to 127.0.0.1 by default and refuses anything else unless FAKE_ERP_ALLOW_REMOTE=true is set explicitly.
import path from "node:path";
import { createFakeErp } from "./app";

const host = process.env.FAKE_ERP_HOST || "127.0.0.1";
const port = Number(process.env.FAKE_ERP_PORT) || 4100;
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
if (!loopback && process.env.FAKE_ERP_ALLOW_REMOTE !== "true") {
  console.error(`Refusing to bind the FAKE ERP to "${host}": it is a development tool and must stay on localhost. Set FAKE_ERP_ALLOW_REMOTE=true only if you really know what you are doing.`);
  process.exit(1);
}

const erp = createFakeErp({ dataFile: path.join(__dirname, "data", "erp.json"), env: process.env });
erp.server.listen(port, host, () => {
  const s = erp.effective();
  console.log(`FAKE ERP (development tool) listening on http://${host}:${port}`);
  console.log(`  WMS webhook target : ${s.wmsBaseUrl}/api/webhooks/${s.publicId || "(public id not set: open Settings)"}`);
  console.log(`  WMS events arrive at: http://${host}:${port}/wms/events   (use this as the integration's target URL)`);
  console.log(`  secrets: inbound ${s.inboundSecret ? "set" : "NOT set"}, outbound ${s.outboundSecret ? "set" : "NOT set"} (values are never printed)`);
});

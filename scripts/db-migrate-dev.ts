// `npm run db:migrate -- --name <migration_name>`
// Runs `prisma migrate dev` only after confirming DATABASE_URL is the development database.
import { spawnSync } from "node:child_process";
import { assertDevDatabase } from "../src/server/db/safety";

try {
  const name = assertDevDatabase(process.env.DATABASE_URL);
  console.log(`Target: development database "${name}"`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);

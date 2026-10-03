// `npm run db:migrate:test` — applies existing migrations to the TEST database only.
import { spawnSync } from "node:child_process";
import { assertTestDatabase } from "../src/server/db/safety";

export function migrateTestDatabase(testUrl: string | undefined, devUrl: string | undefined): void {
  const name = assertTestDatabase(testUrl, devUrl);
  console.log(`Applying migrations to test database "${name}"`);
  const result = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    stdio: "inherit",
    // Point Prisma at the test database for this child process only.
    env: { ...process.env, DATABASE_URL: testUrl },
  });
  if (result.status !== 0) throw new Error("prisma migrate deploy failed for the test database");
}

if (process.argv[1]?.endsWith("db-migrate-test.ts")) {
  try {
    migrateTestDatabase(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

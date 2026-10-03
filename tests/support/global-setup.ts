// Runs once before the suite: verify the target is the test database, then bring its schema
// up to date with `prisma migrate deploy`. Never touches the development database.
import { loadEnv } from "vite";
import { assertTestDatabase } from "../../src/server/db/safety";
import { migrateTestDatabase } from "../../scripts/db-migrate-test";

export default function setup() {
  const fileEnv = loadEnv("test", process.cwd(), "");
  const testUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  const devUrl = fileEnv.DATABASE_URL;
  assertTestDatabase(testUrl, devUrl);

  migrateTestDatabase(testUrl, devUrl);
}

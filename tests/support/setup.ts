// Runs in every test worker before any test file. Defense in depth: the application client
// (which reads DATABASE_URL) must be pointed at the test database.
import { assertTestDatabase } from "../../src/server/db/safety";

assertTestDatabase(process.env.DATABASE_URL);
assertTestDatabase(process.env.TEST_DATABASE_URL);
if (process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL) {
  throw new Error("Refusing to run: DATABASE_URL must equal TEST_DATABASE_URL inside tests.");
}

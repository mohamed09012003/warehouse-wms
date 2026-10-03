// Pure helpers that keep automated tests and tooling away from the wrong database.
// No imports from the app so they can be used by scripts, vitest config and tests.

/** The only database name automated tests may touch. */
export const TEST_DATABASE_NAME = "warehouse_wms_test";
/** The development database. Tests must never run against it. */
export const DEV_DATABASE_NAME = "warehouse_wms";

export function databaseNameFromUrl(url: string | undefined): string {
  if (!url) throw new Error("Database URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Database URL is not a valid URL");
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!name) throw new Error("Database URL does not name a database");
  return name;
}

/**
 * Throws unless `testUrl` points at the dedicated test database.
 * If `devUrl` is supplied it must additionally name a different database.
 * Error messages contain database names only, never the URL (which holds credentials).
 */
export function assertTestDatabase(testUrl: string | undefined, devUrl?: string): string {
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL is not set. Automated tests require a separate test database.");
  }
  const name = databaseNameFromUrl(testUrl);
  if (name === DEV_DATABASE_NAME) {
    throw new Error(`Refusing to run: TEST_DATABASE_URL points at the development database "${name}".`);
  }
  if (name !== TEST_DATABASE_NAME) {
    throw new Error(`Refusing to run: test database must be named "${TEST_DATABASE_NAME}", got "${name}".`);
  }
  if (devUrl && databaseNameFromUrl(devUrl) === name) {
    throw new Error("Refusing to run: DATABASE_URL and TEST_DATABASE_URL name the same database.");
  }
  return name;
}

/** Throws unless `devUrl` points at the development database (used before dev migrations). */
export function assertDevDatabase(devUrl: string | undefined): string {
  const name = databaseNameFromUrl(devUrl);
  if (name !== DEV_DATABASE_NAME) {
    throw new Error(`Refusing to run: expected development database "${DEV_DATABASE_NAME}", got "${name}".`);
  }
  return name;
}

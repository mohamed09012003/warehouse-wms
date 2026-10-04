import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { assertTestDatabase } from "./src/server/db/safety";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const testUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;

  // Hard stop: if this does not point at the dedicated test database, no test is executed.
  assertTestDatabase(testUrl, devUrl);

  return {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        // The real package throws outside React Server Components.
        "server-only": path.resolve(__dirname, "tests/support/server-only-stub.ts"),
      },
    },
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
      globalSetup: ["tests/support/global-setup.ts"],
      setupFiles: ["tests/support/setup.ts"],
      // Tests share one database and truncate between cases.
      fileParallelism: false,
      env: {
        // The application reads DATABASE_URL; in tests that is ALWAYS the test database.
        DATABASE_URL: testUrl,
        TEST_DATABASE_URL: testUrl,
        // Fixed fake value for tests only; not a real secret.
        AUTH_SECRET: "test-only-auth-secret-not-for-real-use-0123456789",
        // Fixed fake vault keys for tests only (second key lets tests exercise key rotation); not real secrets.
        INTEGRATION_ENCRYPTION_KEYS: `test1:${Buffer.from("test-only-fake-vault-key-numbr-1").toString("base64")},test0:${Buffer.from("test-only-fake-vault-key-numbr-0").toString("base64")}`,
        // Tests run a local HTTP server as the "external system"; SSRF-policy tests build their own strict client.
        INTEGRATIONS_ALLOW_PRIVATE_TARGETS: "true",
      },
    },
  };
});

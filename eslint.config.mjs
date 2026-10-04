import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const prismaPatterns = (message) => [
  { group: ["@/server/db/client", "**/server/db/client"], message },
  { group: ["@/generated/prisma/*", "@prisma/client"], message },
];

// The WMS core never imports the integration layer (CLAUDE.md rule 14): adapters depend on core ports,
// never the reverse. Core modules publish events through modules/outbox instead.
const integrationsBan = {
  group: ["@/integrations", "@/integrations/*", "**/integrations/**", "**/src/integrations"],
  message: "The WMS core must not import src/integrations. Publish a domain event through modules/outbox instead.",
};

const restrict = (...patterns) => ({ "no-restricted-imports": ["error", { patterns }] });

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The core (domain modules, shared server code, utilities) must not depend on the integration layer.
  {
    files: ["src/modules/**/*.{ts,tsx}", "src/server/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    ignores: ["**/__tests__/**"],
    rules: restrict(integrationsBan),
  },
  // Layering rule (CLAUDE.md #12): UI and routes never touch the raw Prisma client.
  {
    files: ["src/app/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"],
    rules: restrict(...prismaPatterns("Do not use the raw Prisma client here. Use a repository (modules/*/repo) or withTransaction.")),
  },
  // Services, domain code and auth go through repositories; services use withTransaction from "@/server/db".
  {
    files: ["src/modules/*/service/**/*.ts", "src/modules/*/domain/**/*.ts", "src/server/auth/**/*.ts"],
    rules: restrict(
      ...prismaPatterns("Do not use the raw Prisma client here. Use a repository (modules/*/repo) or withTransaction."),
      integrationsBan,
    ),
  },
  // Domain code must be pure: no framework or infrastructure imports.
  {
    files: ["src/modules/*/domain/**/*.ts"],
    rules: restrict({ group: ["@/server/*", "next/*", "react", "@/generated/*", "@prisma/*"] }, integrationsBan),
  },
  // Inside the integration layer only repositories and the secret store touch Prisma; services, adapters,
  // the HTTP client and the worker go through them.
  {
    files: [
      "src/integrations/service/**/*.ts",
      "src/integrations/core/**/*.ts",
      "src/integrations/adapters/**/*.ts",
      "src/integrations/http/**/*.ts",
      "src/integrations/worker/**/*.ts",
      "src/integrations/schemas/**/*.ts",
    ],
    ignores: ["**/__tests__/**"],
    rules: restrict(...prismaPatterns("Use an integrations repository (src/integrations/repo) instead of the raw Prisma client.")),
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**"]),
]);

export default eslintConfig;

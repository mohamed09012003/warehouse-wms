import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const restrictPrisma = (message) => ({
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        { group: ["@/server/db/client", "**/server/db/client"], message },
        { group: ["@/generated/prisma/*", "@prisma/client"], message },
      ],
    },
  ],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Layering rule (CLAUDE.md #12): UI, routes, services and domain code never touch the raw
  // Prisma client. They go through repositories; services use withTransaction from "@/server/db".
  {
    files: [
      "src/app/**/*.{ts,tsx}",
      "src/ui/**/*.{ts,tsx}",
      "src/modules/*/service/**/*.ts",
      "src/modules/*/domain/**/*.ts",
      "src/server/auth/**/*.ts",
    ],
    rules: restrictPrisma("Do not use the raw Prisma client here. Use a repository (modules/*/repo) or withTransaction."),
  },
  // Domain code must be pure: no framework or infrastructure imports.
  {
    files: ["src/modules/*/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: ["@/server/*", "next/*", "react", "@/generated/*", "@prisma/*"] },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/generated/**"]),
]);

export default eslintConfig;

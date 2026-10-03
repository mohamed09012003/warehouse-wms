import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env on its own. Node can; ignore if the file is absent
// (e.g. CI, where variables come from the real environment).
try {
  process.loadEnvFile(".env");
} catch {
  // no .env file
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --env-file-if-exists=.env prisma/seed.ts",
  },
  datasource: {
    // Fallback keeps `prisma generate` working without a database configured.
    url: process.env.DATABASE_URL ?? "postgresql://placeholder:placeholder@localhost:5432/placeholder",
  },
});

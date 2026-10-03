// Development seed. FAKE DATA ONLY. Run with: npm run db:seed
// Refuses to run unless DATABASE_URL names the development database.
import { randomBytes } from "node:crypto";
import { assertDevDatabase } from "../src/server/db/safety";

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed in production.");
  const dbName = assertDevDatabase(process.env.DATABASE_URL);

  // Imported after the guard so nothing connects to a wrong database.
  const { prisma } = await import("../src/server/db/client");
  const { createOrganizationWithOwner } = await import("../src/modules/tenancy");

  const slug = "demo-org";
  const existing = await prisma.organization.findUnique({ where: { slug } });
  if (existing) {
    console.log(`Seed skipped: organization "${slug}" already exists in ${dbName}.`);
    return;
  }

  // The demo password is never stored in source: use SEED_DEMO_PASSWORD or a random one printed once.
  const generated = !process.env.SEED_DEMO_PASSWORD;
  const password = process.env.SEED_DEMO_PASSWORD ?? randomBytes(9).toString("base64url");

  await createOrganizationWithOwner({
    name: "Demo Organization",
    slug,
    owner: { email: "demo@example.com", name: "Demo User", password },
  });

  console.log(`Seeded ${dbName}: organization "${slug}", user demo@example.com`);
  if (generated) console.log(`Generated demo password (shown once): ${password}`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import { assertTestDatabase } from "../../src/server/db/safety";
import { prisma } from "../../src/server/db/client";

export { prisma };

/** Empty every table. Only ever runs against the test database. */
export async function resetDatabase(): Promise<void> {
  assertTestDatabase(process.env.DATABASE_URL);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

let counter = 0;
/** Unique, obviously fake fixture identifiers. */
export function fakeOrg(label = "org") {
  counter += 1;
  const n = `${label}-${counter}`;
  return {
    name: `Test ${n}`,
    slug: n,
    owner: { email: `owner-${n}@example.test`, name: `Owner ${n}`, password: "correct-horse-battery" },
  };
}

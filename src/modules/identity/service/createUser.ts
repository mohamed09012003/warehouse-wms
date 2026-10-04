import { randomUUID } from "node:crypto";
import { parseInput } from "@/lib/errors";
import type { DbClient } from "@/server/db";
import { hashPassword } from "../domain/password";
import { insertUser } from "../repo/userRepo";
import { createUserSchema } from "../schemas";

/** Create a global user identity. Accepts a transaction client so callers can compose it. */
export async function createUser(input: unknown, db?: DbClient) {
  const data = parseInput(createUserSchema, input);
  const passwordHash = await hashPassword(data.password);
  const user = await insertUser({ email: data.email, name: data.name, passwordHash }, db);
  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Create the dedicated NON-LOGIN user an integration acts as. It exists so the actor foreign keys of
 * orders, products and the like point at a real row. It can never sign in: the password hash is not a valid
 * scrypt string (verifyPassword always returns false), the user is disabled, the e-mail uses the reserved
 * .invalid TLD and no Membership is created, so it also never shows up in member lists.
 */
export async function createIntegrationServiceUser(db: DbClient, label: string) {
  const user = await insertUser(
    {
      email: `integration-${randomUUID()}@integration.invalid`,
      name: `Integration: ${label}`.slice(0, 120),
      passwordHash: "!",
      disabledAt: new Date(),
    },
    db,
  );
  return { id: user.id };
}

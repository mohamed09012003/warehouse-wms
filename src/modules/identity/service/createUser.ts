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

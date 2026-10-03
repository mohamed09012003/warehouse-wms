// Users are global identities (not tenant-owned), so these functions are not tenant-scoped.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";

export function findUserByEmail(email: string, db: DbClient = prisma) {
  return db.user.findUnique({ where: { email } });
}

export function findUserById(id: string, db: DbClient = prisma) {
  return db.user.findUnique({ where: { id } });
}

export function insertUser(
  data: { email: string; name: string; passwordHash: string },
  db: DbClient = prisma,
) {
  return db.user.create({ data });
}

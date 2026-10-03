// Tenant-scoped repositories. Each factory takes a TenantContext and injects
// organizationId into EVERY query, so callers cannot forget (or override) the tenant filter.
// Pattern for all future modules: repo(ctx, db = prisma).
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "../domain/context";

export function organizationRepo(ctx: TenantContext, db: DbClient = prisma) {
  return {
    get: () => db.organization.findUniqueOrThrow({ where: { id: ctx.organizationId } }),
  };
}

export function roleRepo(ctx: TenantContext, db: DbClient = prisma) {
  const scope = { organizationId: ctx.organizationId };
  return {
    list: () => db.role.findMany({ where: scope, orderBy: { name: "asc" } }),
    findById: (id: string) => db.role.findFirst({ where: { ...scope, id } }),
    findByName: (name: string) => db.role.findFirst({ where: { ...scope, name } }),
  };
}

export function membershipRepo(ctx: TenantContext, db: DbClient = prisma) {
  const scope = { organizationId: ctx.organizationId };
  return {
    list: () =>
      db.membership.findMany({
        where: scope,
        include: { user: { select: { id: true, email: true, name: true } }, role: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      }),
    count: () => db.membership.count({ where: { ...scope, status: "ACTIVE" } }),
    findById: (id: string) => db.membership.findFirst({ where: { ...scope, id } }),
  };
}

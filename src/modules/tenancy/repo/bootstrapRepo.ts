// Cross-tenant lookups that exist BEFORE a TenantContext can exist (resolving it, listing a
// user's organizations, creating an organization). Keep this file small and audited:
// everything here is keyed by the authenticated user id or creates a brand-new tenant.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { Permission } from "../domain/permissions";

export function findMembershipForUserBySlug(userId: string, orgSlug: string, db: DbClient = prisma) {
  return db.membership.findFirst({
    where: { userId, organization: { slug: orgSlug } },
    include: { organization: true, role: true, user: { select: { disabledAt: true } } },
  });
}

export function listMembershipsForUser(userId: string, db: DbClient = prisma) {
  return db.membership.findMany({
    where: { userId, status: "ACTIVE" },
    include: { organization: { select: { id: true, slug: true, name: true } }, role: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export function insertOrganization(data: { name: string; slug: string }, db: DbClient = prisma) {
  return db.organization.create({ data });
}

export function insertRole(
  data: { organizationId: string; name: string; permissions: readonly Permission[]; isSystem: boolean },
  db: DbClient = prisma,
) {
  return db.role.create({ data: { ...data, permissions: [...data.permissions] } });
}

export function insertMembership(
  data: { organizationId: string; userId: string; roleId: string },
  db: DbClient = prisma,
) {
  return db.membership.create({ data });
}

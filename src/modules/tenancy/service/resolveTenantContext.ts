import { AuthorizationError } from "@/lib/errors";
import type { TenantContext } from "../domain/context";
import { findMembershipForUserBySlug, listMembershipsForUser } from "../repo/bootstrapRepo";

/**
 * Turn (authenticated user id, organization slug from the URL) into a verified TenantContext.
 *
 * The slug is only a lookup key. Authorization comes from the database: the user must have an
 * ACTIVE membership in that organization and must not be disabled. Anything else throws the
 * same AuthorizationError, so a non-member cannot tell "no such org" from "not your org".
 */
export async function resolveTenantContext(userId: string, orgSlug: string): Promise<TenantContext> {
  const membership = await findMembershipForUserBySlug(userId, orgSlug);
  if (!membership || membership.status !== "ACTIVE" || membership.user.disabledAt) {
    throw new AuthorizationError();
  }
  return {
    organizationId: membership.organizationId,
    organizationSlug: membership.organization.slug,
    userId,
    membershipId: membership.id,
    roleId: membership.roleId,
    roleName: membership.role.name,
    permissions: new Set(membership.role.permissions),
  };
}

export async function listUserOrganizations(userId: string) {
  const memberships = await listMembershipsForUser(userId);
  return memberships.map((m) => ({ id: m.organization.id, slug: m.organization.slug, name: m.organization.name, roleName: m.role.name }));
}

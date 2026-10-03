import { ConflictError, parseInput } from "@/lib/errors";
import { withTransaction } from "@/server/db";
import { createUser } from "@/modules/identity";
import { DEFAULT_ROLES, OWNER_ROLE_NAME } from "../domain/permissions";
import { insertMembership, insertOrganization, insertRole } from "../repo/bootstrapRepo";
import { createOrganizationSchema } from "../schemas";

/**
 * Create an organization with its default roles and an Owner membership, atomically.
 * Used by seed/tests today; a signup or admin UI can call it later.
 */
export async function createOrganizationWithOwner(input: unknown) {
  const data = parseInput(createOrganizationSchema, input);

  try {
    return await withTransaction(async (tx) => {
      const organization = await insertOrganization({ name: data.name, slug: data.slug }, tx);

      const roles = new Map<string, string>();
      for (const def of DEFAULT_ROLES) {
        const role = await insertRole(
          { organizationId: organization.id, name: def.name, permissions: def.permissions, isSystem: true },
          tx,
        );
        roles.set(def.name, role.id);
      }

      const ownerUserId = "userId" in data.owner ? data.owner.userId : (await createUser(data.owner, tx)).id;
      const membership = await insertMembership(
        { organizationId: organization.id, userId: ownerUserId, roleId: roles.get(OWNER_ROLE_NAME)! },
        tx,
      );
      return { organization, membership, ownerUserId };
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "P2002") {
      throw new ConflictError("An organization with this slug (or a user with this email) already exists");
    }
    throw error;
  }
}

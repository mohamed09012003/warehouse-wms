import { beforeEach, describe, expect, it } from "vitest";
import { fakeOrg, prisma, resetDatabase } from "../../../../tests/support/db";
import { AuthorizationError, ConflictError, ValidationError } from "@/lib/errors";
import { createUser } from "@/modules/identity";
import {
  DEFAULT_ROLES,
  createOrganizationWithOwner,
  getDashboardSummary,
  listUserOrganizations,
  requirePermission,
  resolveTenantContext,
} from "..";
import { membershipRepo, roleRepo } from "../repo/tenantRepos";

beforeEach(resetDatabase);

describe("organization creation", () => {
  it("creates the org, default roles and an Owner membership atomically", async () => {
    const input = fakeOrg();
    const { organization, membership } = await createOrganizationWithOwner(input);

    const roles = await prisma.role.findMany({ where: { organizationId: organization.id } });
    expect(roles.map((r) => r.name).sort()).toEqual(DEFAULT_ROLES.map((r) => r.name).sort());
    expect(roles.every((r) => r.organizationId === organization.id)).toBe(true);

    const owner = roles.find((r) => r.name === "Owner")!;
    expect(membership.roleId).toBe(owner.id);
    expect(membership.status).toBe("ACTIVE");
  });

  it("rolls everything back when a step fails (duplicate owner email)", async () => {
    const a = fakeOrg();
    await createOrganizationWithOwner(a);
    const b = { ...fakeOrg(), owner: { ...fakeOrg().owner, email: a.owner.email } };
    await expect(createOrganizationWithOwner(b)).rejects.toBeInstanceOf(ConflictError);
    expect(await prisma.organization.findUnique({ where: { slug: b.slug } })).toBeNull();
  });

  it("rejects duplicate and invalid slugs", async () => {
    const a = fakeOrg();
    await createOrganizationWithOwner(a);
    await expect(createOrganizationWithOwner({ ...fakeOrg(), slug: a.slug })).rejects.toBeInstanceOf(ConflictError);
    await expect(createOrganizationWithOwner({ ...fakeOrg(), slug: "Bad Slug!" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createOrganizationWithOwner({ ...fakeOrg(), slug: "api" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("memberships: users are global, membership links them to organizations", () => {
  it("lets one user belong to several organizations with different roles", async () => {
    const a = await createOrganizationWithOwner(fakeOrg("a"));
    const b = await createOrganizationWithOwner(fakeOrg("b"));
    const memberRoleB = await prisma.role.findFirstOrThrow({
      where: { organizationId: b.organization.id, name: "Member" },
    });
    await prisma.membership.create({
      data: { organizationId: b.organization.id, userId: a.ownerUserId, roleId: memberRoleB.id },
    });

    const orgs = await listUserOrganizations(a.ownerUserId);
    expect(orgs.map((o) => [o.slug, o.roleName]).sort()).toEqual(
      [[a.organization.slug, "Owner"], [b.organization.slug, "Member"]].sort(),
    );
  });

  it("allows only one membership per user per organization", async () => {
    const a = await createOrganizationWithOwner(fakeOrg());
    const role = await prisma.role.findFirstOrThrow({ where: { organizationId: a.organization.id } });
    await expect(
      prisma.membership.create({
        data: { organizationId: a.organization.id, userId: a.ownerUserId, roleId: role.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("tenant isolation foundations", () => {
  it("database rejects a membership whose role belongs to another organization", async () => {
    const a = await createOrganizationWithOwner(fakeOrg("a"));
    const b = await createOrganizationWithOwner(fakeOrg("b"));
    const roleOfB = await prisma.role.findFirstOrThrow({ where: { organizationId: b.organization.id } });
    const stranger = await createUser(fakeOrg("s").owner);

    // Composite FK (organizationId, roleId) -> Role(organizationId, id)
    await expect(
      prisma.membership.create({
        data: { organizationId: a.organization.id, userId: stranger.id, roleId: roleOfB.id },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("scoped repositories never return another organization's rows", async () => {
    const a = await createOrganizationWithOwner(fakeOrg("a"));
    const b = await createOrganizationWithOwner(fakeOrg("b"));
    const ctxA = await resolveTenantContext(a.ownerUserId, a.organization.slug);

    const roles = await roleRepo(ctxA).list();
    expect(roles.length).toBe(DEFAULT_ROLES.length);
    expect(roles.every((r) => r.organizationId === a.organization.id)).toBe(true);

    const members = await membershipRepo(ctxA).list();
    expect(members.map((m) => m.user.id)).toEqual([a.ownerUserId]);

    // Looking up B's ids through A's repo finds nothing, even with a valid id.
    const roleOfB = await prisma.role.findFirstOrThrow({ where: { organizationId: b.organization.id } });
    expect(await roleRepo(ctxA).findById(roleOfB.id)).toBeNull();
    expect(await membershipRepo(ctxA).findById(b.membership.id)).toBeNull();
  });

  it("resolveTenantContext: members get a context, non-members are refused", async () => {
    const a = await createOrganizationWithOwner(fakeOrg("a"));
    const b = await createOrganizationWithOwner(fakeOrg("b"));

    const ctx = await resolveTenantContext(a.ownerUserId, a.organization.slug);
    expect(ctx.organizationId).toBe(a.organization.id);
    expect(ctx.roleName).toBe("Owner");

    // The slug is untrusted: A's owner asking for B's slug is refused, as is an unknown slug.
    await expect(resolveTenantContext(a.ownerUserId, b.organization.slug)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(resolveTenantContext(a.ownerUserId, "does-not-exist")).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("refuses disabled memberships and disabled users", async () => {
    const a = await createOrganizationWithOwner(fakeOrg());
    await prisma.membership.update({ where: { id: a.membership.id }, data: { status: "DISABLED" } });
    await expect(resolveTenantContext(a.ownerUserId, a.organization.slug)).rejects.toBeInstanceOf(AuthorizationError);

    await prisma.membership.update({ where: { id: a.membership.id }, data: { status: "ACTIVE" } });
    await prisma.user.update({ where: { id: a.ownerUserId }, data: { disabledAt: new Date() } });
    await expect(resolveTenantContext(a.ownerUserId, a.organization.slug)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("permissions", () => {
  it("derive from the member's role; Member cannot manage members", async () => {
    const a = await createOrganizationWithOwner(fakeOrg());
    const memberRole = await prisma.role.findFirstOrThrow({
      where: { organizationId: a.organization.id, name: "Member" },
    });
    const user = await createUser(fakeOrg("m").owner);
    await prisma.membership.create({
      data: { organizationId: a.organization.id, userId: user.id, roleId: memberRole.id },
    });

    const ctx = await resolveTenantContext(user.id, a.organization.slug);
    expect(() => requirePermission(ctx, "org.read")).not.toThrow();
    expect(() => requirePermission(ctx, "members.manage")).toThrow(AuthorizationError);
    expect((await getDashboardSummary(ctx)).memberCount).toBe(2);
  });
});

import { requirePermission, type TenantContext } from "../domain/context";
import { membershipRepo, organizationRepo } from "../repo/tenantRepos";

export async function getDashboardSummary(ctx: TenantContext) {
  requirePermission(ctx, "org.read");
  const [organization, memberCount] = await Promise.all([organizationRepo(ctx).get(), membershipRepo(ctx).count()]);
  return {
    organizationName: organization.name,
    organizationSlug: organization.slug,
    roleName: ctx.roleName,
    memberCount,
  };
}

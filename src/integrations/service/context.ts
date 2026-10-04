// The server-side counterpart of resolveTenantContext for non-human actors.
//
// An integration acts through its dedicated service user with ONLY the permissions in `grants`
// (allowlist: products.manage, orders.manage, plus their view permissions). It has no membership and
// no role; the organization comes from the Integration row, never from request input. The synthetic
// ids below exist only to satisfy the TenantContext shape: no service reads membershipId/roleId.
import { AuthorizationError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy";
import { integrationPermissions } from "../core/grants";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function resolveIntegrationContext(integration: {
  id: string;
  organizationId: string;
  name: string;
  grants: readonly string[];
  serviceUserId: string;
  archivedAt: Date | null;
  organization: { slug: string };
}): TenantContext {
  if (integration.archivedAt) throw new AuthorizationError("This integration is archived");
  return {
    organizationId: integration.organizationId,
    organizationSlug: integration.organization.slug,
    userId: integration.serviceUserId,
    membershipId: integration.id,
    roleId: NIL_UUID,
    roleName: "integration",
    permissions: integrationPermissions(integration.grants),
  };
}

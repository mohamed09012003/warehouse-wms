// Public API of the tenancy module.
export type { TenantContext } from "./domain/context";
export { hasPermission, requirePermission } from "./domain/context";
export { PERMISSIONS, DEFAULT_ROLES } from "./domain/permissions";
export type { Permission } from "./domain/permissions";
export { resolveTenantContext, listUserOrganizations } from "./service/resolveTenantContext";
export { createOrganizationWithOwner } from "./service/createOrganization";
export { getDashboardSummary } from "./service/dashboard";

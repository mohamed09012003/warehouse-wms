import { AuthorizationError } from "@/lib/errors";
import type { Permission } from "./permissions";

/**
 * Proof that the SERVER verified `userId` is an active member of `organizationId`.
 * It is only ever produced by resolveTenantContext(); never build one from client input.
 * All tenant-scoped repositories take a TenantContext.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly permissions: ReadonlySet<string>;
}

export function hasPermission(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!hasPermission(ctx, permission)) {
    throw new AuthorizationError(`Missing permission: ${permission}`);
  }
}

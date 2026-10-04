// What an integration actor may do. The allowlist is the whole story: anything else (inventory.*,
// warehouse.*, picking.manage, packing.manage, members/roles/org permissions, integrations.*) can never
// be granted: not by the service, and not by the database (CHECK on Integration.grants).
import type { Permission } from "@/modules/tenancy";

export const ALLOWED_GRANTS = ["products.manage", "orders.manage"] as const;
export type IntegrationGrant = (typeof ALLOWED_GRANTS)[number];

export function isAllowedGrant(value: string): value is IntegrationGrant {
  return (ALLOWED_GRANTS as readonly string[]).includes(value);
}

/** The "view" permission that goes with each grant (services read back what they just wrote). */
const IMPLIED: Record<IntegrationGrant, Permission> = {
  "products.manage": "products.view",
  "orders.manage": "orders.view",
};

/** The effective permission set of an integration actor. Never contains anything beyond the allowlist and its views. */
export function integrationPermissions(grants: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const g of grants) {
    if (!isAllowedGrant(g)) continue; // defence in depth; the DB CHECK rejects such rows anyway
    out.add(g);
    out.add(IMPLIED[g]);
  }
  return out;
}

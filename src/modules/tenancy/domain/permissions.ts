// Permission NAMES are defined in code because they gate code paths.
// Which role holds which permission is data (Role.permissions). Phase 1 keeps this minimal;
// later phases add permissions such as "warehouse.design" or "inventory.adjust".
export const PERMISSIONS = [
  "org.read",
  "org.manage",
  "members.manage",
  "roles.manage",
  "warehouse.view",
  "warehouse.design",
  "products.view",
  "products.manage",
  "inventory.view",
  // receive, move and adjust stock
  "inventory.adjust",
  // create and release reservations
  "inventory.reserve",
  "orders.view",
  "orders.manage",
  "picking.view",
  // allocate, manage waves, confirm picks
  "picking.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Default roles created for every new organization. Editable afterwards (data). */
export const DEFAULT_ROLES: ReadonlyArray<{ name: string; permissions: readonly Permission[] }> = [
  { name: "Owner", permissions: PERMISSIONS },
  {
    name: "Admin",
    permissions: [
      "org.read",
      "org.manage",
      "members.manage",
      "warehouse.view",
      "warehouse.design",
      "products.view",
      "products.manage",
      "inventory.view",
      "inventory.adjust",
      "inventory.reserve",
      "orders.view",
      "orders.manage",
      "picking.view",
      "picking.manage",
    ],
  },
  {
    name: "Member",
    permissions: ["org.read", "warehouse.view", "products.view", "inventory.view", "orders.view", "picking.view"],
  },
];

export const OWNER_ROLE_NAME = "Owner";

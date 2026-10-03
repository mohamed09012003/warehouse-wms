// Navigation definition for the application shell. Future phases replace placeholders.
export interface NavItem {
  label: string;
  /** Path relative to /[orgSlug]; "" is the dashboard. */
  path: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", path: "" },
  { label: "Warehouse", path: "warehouse" },
  { label: "Products", path: "products" },
  { label: "Inventory", path: "inventory" },
  { label: "Orders", path: "orders" },
  { label: "Picking", path: "picking" },
  { label: "Packing", path: "packing" },
  { label: "Integrations", path: "integrations" },
  { label: "Settings", path: "settings" },
];

// Shared fixtures for Phase 3 tests. Everything here is obviously fake test data.
import { randomUUID } from "node:crypto";
import { createProduct } from "@/modules/catalog";
import { createUser } from "@/modules/identity";
import { createOrganizationWithOwner, resolveTenantContext, type TenantContext } from "@/modules/tenancy";
import { createWarehouse, getLayout, saveLayout, type LayoutDto } from "@/modules/warehouse";
import { suggestBays, suggestLevels } from "@/modules/warehouse/domain/structure";
import { fakeOrg, prisma } from "./db";

export async function newTenant(label = "t") {
  const org = await createOrganizationWithOwner(fakeOrg(label));
  const ctx = await resolveTenantContext(org.ownerUserId, org.organization.slug);
  return { org, ctx };
}

/** A member of `org` with the named built-in role ("Member", "Admin", ...). */
export async function ctxWithRole(org: Awaited<ReturnType<typeof newTenant>>["org"], roleName: string): Promise<TenantContext> {
  const role = await prisma.role.findFirstOrThrow({ where: { organizationId: org.organization.id, name: roleName } });
  const user = await createUser(fakeOrg("u").owner);
  await prisma.membership.create({ data: { organizationId: org.organization.id, userId: user.id, roleId: role.id } });
  return resolveTenantContext(user.id, org.organization.slug);
}

export function rackSpec(code: string, opts: { levels?: number; bays?: number; positionsPerBay?: number } = {}) {
  const bays = opts.bays ?? 3;
  const bayWidth = 2000;
  return {
    id: randomUUID(),
    code,
    name: null,
    xMm: 5000,
    yMm: 5000,
    rotationDeg: 0,
    lengthMm: bays * bayWidth,
    depthMm: 1100,
    heightMm: 6000,
    levels: suggestLevels(6000, opts.levels ?? 2, { baseElevationMm: 150, beamMm: 100 }),
    bays: suggestBays(bays * bayWidth, bayWidth, { positionCount: opts.positionsPerBay ?? 1 }).bays,
  };
}

export function layoutPayload(layout: LayoutDto, patch: Record<string, unknown> = {}) {
  return {
    version: layout.warehouse.layoutVersion,
    warehouse: { name: layout.warehouse.name, widthMm: layout.warehouse.widthMm, lengthMm: layout.warehouse.lengthMm },
    objects: layout.objects,
    racks: layout.racks,
    ...patch,
  };
}

/** A tenant with one warehouse and one rack (R01: 2 levels x 3 bays x 1 position = 6 positions). */
export async function tenantWithWarehouse(label = "t", rackOpts: Parameters<typeof rackSpec>[1] = {}) {
  const t = await newTenant(label);
  const wh = await createWarehouse(t.ctx, { code: "MAIN", name: "Main", widthMm: 40000, lengthMm: 30000 });
  const rack = rackSpec("R01", rackOpts);
  await saveLayout(t.ctx, wh.id, layoutPayload(await getLayout(t.ctx, wh.id), { racks: [rack] }));
  const positions = await prisma.position.findMany({ where: { organizationId: t.org.organization.id }, orderBy: { code: "asc" } });
  const byCode = (code: string) => positions.find((p) => p.code === code)!;
  return { ...t, warehouseId: wh.id, rack, positions, byCode };
}

let skuCounter = 0;
export async function makeProduct(ctx: TenantContext, sku?: string) {
  skuCounter += 1;
  return createProduct(ctx, { sku: sku ?? `SKU-${skuCounter}`, name: `Test product ${skuCounter}` });
}

/**
 * Reconciliation: for every balance, onHand == sum(qtyDelta) and reserved == sum(reservedDelta)
 * of its ledger rows. Throws with details on any mismatch.
 */
export async function assertLedgerMatchesBalances() {
  const rows = await prisma.$queryRaw<
    { positionId: string; productId: string; onHand: number; reserved: number; sumQty: bigint | null; sumRes: bigint | null }[]
  >`
    SELECT b."positionId", b."productId", b."onHand", b."reserved",
           (SELECT COALESCE(SUM(m."qtyDelta"), 0) FROM "InventoryMovement" m WHERE m."positionId" = b."positionId" AND m."productId" = b."productId") AS "sumQty",
           (SELECT COALESCE(SUM(m."reservedDelta"), 0) FROM "InventoryMovement" m WHERE m."positionId" = b."positionId" AND m."productId" = b."productId") AS "sumRes"
      FROM "InventoryBalance" b`;
  const bad = rows.filter((r) => Number(r.sumQty) !== r.onHand || Number(r.sumRes) !== r.reserved);
  if (bad.length) throw new Error(`Ledger/balance mismatch: ${JSON.stringify(bad, (_, v) => (typeof v === "bigint" ? Number(v) : v))}`);
  // Invariants on every balance
  const invalid = rows.filter((r) => r.onHand < 0 || r.reserved < 0 || r.reserved > r.onHand);
  if (invalid.length) throw new Error("Invalid balance rows found");
}

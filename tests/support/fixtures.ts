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

// ---------------------------------------------------------------------------
// Phase 4 (orders and picking) fixtures
// ---------------------------------------------------------------------------
import { createOrder, type OrderDetailDto } from "@/modules/orders";
import { receiveStock } from "@/modules/inventory";
import { addOrdersToWave, allocateOrder, createWave, releaseWave, startWave } from "@/modules/picking";

let orderCounter = 0;
export async function makeOrder(
  ctx: TenantContext,
  lines: { productId: string; quantity: number }[],
  opts: { ready?: boolean; orderNumber?: string } = {},
): Promise<OrderDetailDto> {
  orderCounter += 1;
  return createOrder(ctx, { orderNumber: opts.orderNumber ?? `ORD-${orderCounter}`, lines, ready: opts.ready ?? true });
}

export async function stockAt(ctx: TenantContext, productId: string, positionId: string, quantity: number) {
  return receiveStock(ctx, { productId, positionId, quantity });
}

/** Allocate an order, put its tasks in a new wave, release and start the wave. Returns the wave id. */
export async function prepareWave(ctx: TenantContext, orderIds: string[]) {
  for (const id of orderIds) await allocateOrder(ctx, { orderId: id });
  const wave = await createWave(ctx, {});
  await addOrdersToWave(ctx, { waveId: wave.id, orderIds });
  await releaseWave(ctx, { waveId: wave.id });
  return (await startWave(ctx, { waveId: wave.id })).id;
}

/** Invariants that must hold at all times for orders, tasks and stock. */
export async function assertPickingInvariants() {
  await assertLedgerMatchesBalances();
  const badLines = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "OrderLine" WHERE "pickedQty" > "allocatedQty" OR "allocatedQty" > "requestedQty" OR "pickedQty" < 0`;
  if (badLines.length) throw new Error("order line invariant broken");
  const badTasks = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PickTask" WHERE "pickedQty" > "quantity" OR "pickedQty" < 0`;
  if (badTasks.length) throw new Error("pick task invariant broken");
  // outstanding reservation (quantity - consumed) of ACTIVE reservations == balances' reserved, in total
  const [{ reservedTotal, activeOutstanding }] = await prisma.$queryRaw<{ reservedTotal: bigint | null; activeOutstanding: bigint | null }[]>`
    SELECT (SELECT COALESCE(SUM("reserved"), 0) FROM "InventoryBalance") AS "reservedTotal",
           (SELECT COALESCE(SUM(l."quantity" - l."consumedQuantity"), 0) FROM "ReservationLine" l
              JOIN "Reservation" r ON r."id" = l."reservationId" WHERE r."status"::text = 'ACTIVE') AS "activeOutstanding"`;
  if (Number(reservedTotal) !== Number(activeOutstanding)) {
    throw new Error(`reserved (${reservedTotal}) != outstanding of active reservations (${activeOutstanding})`);
  }
}

// ---------------------------------------------------------------------------
// Phase 5 (packing) fixtures
// ---------------------------------------------------------------------------
import { confirmPick } from "@/modules/picking";

/**
 * Pick `units` of an order (all tasks, in order) through the real picking flow: allocate, wave,
 * release, start, confirm. `units` defaults to everything allocated.
 */
export async function pickOrder(ctx: TenantContext, orderId: string, units?: number) {
  const waveId = await prepareWave(ctx, [orderId]);
  let left = units ?? Number.MAX_SAFE_INTEGER;
  const tasks = await prisma.pickTask.findMany({ where: { orderId }, orderBy: [{ positionCode: "asc" }, { id: "asc" }], include: { product: true } });
  for (const t of tasks) {
    if (left <= 0) break;
    const qty = Math.min(left, t.quantity);
    await confirmPick(ctx, { taskId: t.id, locationCode: t.positionCode, productCode: t.product.sku, quantity: qty });
    left -= qty;
  }
  return waveId;
}

/** Everything inventory-related, as a string, to prove packing leaves it untouched. */
export async function inventorySnapshot(): Promise<string> {
  const balances = await prisma.inventoryBalance.findMany({ orderBy: { id: "asc" }, select: { id: true, onHand: true, reserved: true, version: true } });
  const movements = await prisma.inventoryMovement.count();
  const operations = await prisma.inventoryOperation.count();
  const reservations = await prisma.reservation.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, lines: { select: { id: true, quantity: true, consumedQuantity: true }, orderBy: { id: "asc" } } } });
  return JSON.stringify({ balances, movements, operations, reservations });
}

/** Invariants that must hold at all times for packing. */
export async function assertPackingInvariants() {
  const lines = await prisma.$queryRaw<{ id: string; packedQty: number; pickedQty: number; inPackages: bigint }[]>`
    SELECT l."id", l."packedQty", l."pickedQty",
           COALESCE((SELECT SUM(i."quantity") FROM "PackageItem" i JOIN "Package" p ON p."id" = i."packageId"
                      WHERE i."orderLineId" = l."id" AND p."status"::text <> 'CANCELLED'), 0) AS "inPackages"
      FROM "OrderLine" l`;
  for (const l of lines) {
    if (l.packedQty > l.pickedQty) throw new Error(`packed ${l.packedQty} > picked ${l.pickedQty} on line ${l.id}`);
    if (Number(l.inPackages) !== l.packedQty) throw new Error(`line ${l.id}: packedQty ${l.packedQty} != contents of live packages ${l.inPackages}`);
  }
  const twoOpen = await prisma.$queryRaw<{ orderId: string }[]>`
    SELECT "orderId" FROM "PackingSession" WHERE "status"::text = 'OPEN' GROUP BY "orderId" HAVING count(*) > 1`;
  if (twoOpen.length) throw new Error("more than one open packing session for an order");
  const badItems = await prisma.packageItem.count({ where: { quantity: { lte: 0 } } });
  if (badItems) throw new Error("package item with a non-positive quantity");
}

// Tenant-scoped data access for packing. This module NEVER reads or writes InventoryBalance,
// InventoryMovement or Reservation: picking already consumed the stock.
//
// LOCK ORDER (extends the picking order): Wave -> Order -> PackingSession -> Package -> PickTask -> ...
// Packing flows use only a subsequence of it: session lifecycle changes lock Order then Session;
// package and item changes lock Session then Package. Item/package changes touch OrderLine only
// through guarded single-statement updates (packedQty + q <= pickedQty), CHECK as the backstop.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";
import type { OrderStatus, PackageStatus, PackingEventType, PackingSessionStatus } from "@/generated/prisma/client";

export interface LockedSession {
  id: string;
  orderId: string;
  status: PackingSessionStatus;
}
export interface LockedPackage {
  id: string;
  sessionId: string;
  orderId: string;
  status: PackageStatus;
  packageNumber: number;
}

export function packingRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  const orgId = ctx.organizationId;

  return {
    // ---- locks ---------------------------------------------------------------------------
    async lockOrder(id: string): Promise<{ id: string; status: OrderStatus; orderNumber: string } | null> {
      const rows = await db.$queryRaw<{ id: string; status: OrderStatus; orderNumber: string }[]>`
        SELECT "id", "status"::text AS "status", "orderNumber" FROM "Order"
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      return rows[0] ?? null;
    },
    async lockSession(id: string): Promise<LockedSession | null> {
      const rows = await db.$queryRaw<LockedSession[]>`
        SELECT "id", "orderId", "status"::text AS "status" FROM "PackingSession"
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      return rows[0] ?? null;
    },
    async lockPackage(id: string): Promise<LockedPackage | null> {
      const rows = await db.$queryRaw<LockedPackage[]>`
        SELECT "id", "sessionId", "orderId", "status"::text AS "status", "packageNumber" FROM "Package"
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      return rows[0] ?? null;
    },

    // ---- reads ---------------------------------------------------------------------------
    findOrder: (id: string) => db.order.findFirst({ where: { ...org, id }, select: { id: true, orderNumber: true, status: true } }),
    orderLines: (orderId: string) =>
      db.orderLine.findMany({ where: { ...org, orderId }, orderBy: { lineNo: "asc" }, include: { product: { select: { sku: true, name: true } } } }),
    findSession: (id: string) => db.packingSession.findFirst({ where: { ...org, id } }),
    sessionsOfOrder: (orderId: string) =>
      db.packingSession.findMany({ where: { ...org, orderId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 20, include: { _count: { select: { packages: true } } } }),
    openSessionOfOrder: (orderId: string) => db.packingSession.findFirst({ where: { ...org, orderId, status: "OPEN" } }),
    findPackage: (id: string) => db.package.findFirst({ where: { ...org, id } }),
    findItem: (id: string) => db.packageItem.findFirst({ where: { ...org, id }, include: { package: { select: { id: true, sessionId: true } } } }),
    sessionWithPackages: (id: string) =>
      db.packingSession.findFirst({
        where: { ...org, id },
        include: {
          order: { select: { orderNumber: true, status: true } },
          packages: {
            orderBy: { packageNumber: "asc" },
            include: { items: { orderBy: { createdAt: "asc" }, include: { product: { select: { sku: true, name: true } } } } },
          },
        },
      }),
    countOpenPackages: (sessionId: string) => db.package.count({ where: { ...org, sessionId, status: "OPEN" } }),
    countCompletedPackages: (sessionId: string) => db.package.count({ where: { ...org, sessionId, status: "COMPLETED" } }),
    openPackagesOfSession: (sessionId: string) =>
      db.package.findMany({ where: { ...org, sessionId, status: "OPEN" }, include: { items: true }, orderBy: { packageNumber: "asc" } }),
    itemsOfPackage: (packageId: string) => db.packageItem.findMany({ where: { ...org, packageId }, orderBy: { id: "asc" } }),

    /** Orders that can be (or are being) packed, with their package counts, for the packing queue. */
    packableOrders: () =>
      db.order.findMany({
        where: { ...org, status: { in: ["PICKING", "PICKED", "PACKING", "PACKED"] } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 300,
        include: {
          lines: { select: { requestedQty: true, pickedQty: true, packedQty: true } },
          packages: { where: { status: { not: "CANCELLED" } }, select: { id: true } },
          packingSessions: { orderBy: [{ startedAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, status: true } },
        },
      }),

    // ---- order status (guarded) ----------------------------------------------------------
    /** Set the order status only if it currently has one of `from`. Returns rows changed. */
    async setOrderStatus(id: string, from: OrderStatus[], to: OrderStatus): Promise<number> {
      return (await db.order.updateMany({ where: { ...org, id, status: { in: from } }, data: { status: to } })).count;
    },

    // ---- packed quantity (guarded) -------------------------------------------------------
    /** packed += qty, only while packed + qty <= picked. false = more than is picked-but-unpacked. */
    async increasePacked(lineId: string, qty: number): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "OrderLine" SET "packedQty" = "packedQty" + ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${lineId}::uuid AND "packedQty" + ${qty}::int <= "pickedQty"`;
      return n === 1;
    },
    /** packed -= qty, only while packed - qty >= 0. */
    async decreasePacked(lineId: string, qty: number): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "OrderLine" SET "packedQty" = "packedQty" - ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${lineId}::uuid AND "packedQty" - ${qty}::int >= 0`;
      return n === 1;
    },

    // ---- sessions ------------------------------------------------------------------------
    createSession: (orderId: string) =>
      db.packingSession.create({ data: { organizationId: orgId, orderId, startedByUserId: ctx.userId } }),
    /** OPEN -> COMPLETED / CANCELLED in one guarded statement. Returns rows changed. */
    async closeSession(id: string, to: "COMPLETED" | "CANCELLED"): Promise<number> {
      const now = new Date();
      return (
        await db.packingSession.updateMany({
          where: { ...org, id, status: "OPEN" },
          data: to === "COMPLETED" ? { status: "COMPLETED", completedAt: now, completedByUserId: ctx.userId } : { status: "CANCELLED", cancelledAt: now },
        })
      ).count;
    },

    // ---- packages ------------------------------------------------------------------------
    /** Next package number for the order (1, 2, 3 ...). Called under the session lock. */
    async nextPackageNumber(orderId: string): Promise<number> {
      const max = await db.package.aggregate({ where: { ...org, orderId }, _max: { packageNumber: true } });
      return (max._max.packageNumber ?? 0) + 1;
    },
    createPackage: (data: {
      sessionId: string;
      orderId: string;
      packageNumber: number;
      packageType: string | null;
      weightG: number | null;
      lengthMm: number | null;
      widthMm: number | null;
      heightMm: number | null;
    }) => db.package.create({ data: { ...data, organizationId: orgId } }),
    updatePackageDetails: (
      id: string,
      data: { packageType?: string | null; weightG?: number | null; lengthMm?: number | null; widthMm?: number | null; heightMm?: number | null },
    ) => db.package.updateMany({ where: { ...org, id, status: "OPEN" }, data }),
    async closePackage(id: string, to: "COMPLETED" | "CANCELLED"): Promise<number> {
      const now = new Date();
      return (
        await db.package.updateMany({
          where: { ...org, id, status: "OPEN" },
          data: to === "COMPLETED" ? { status: "COMPLETED", completedAt: now, completedByUserId: ctx.userId } : { status: "CANCELLED", cancelledAt: now },
        })
      ).count;
    },

    // ---- items ---------------------------------------------------------------------------
    /** Add qty of a line to a package (creating the row, or increasing it). Returns the new quantity. */
    async upsertItem(a: { packageId: string; orderId: string; orderLineId: string; productId: string; qty: number }): Promise<number> {
      const rows = await db.$queryRaw<{ quantity: number }[]>`
        INSERT INTO "PackageItem" ("id", "organizationId", "packageId", "orderId", "orderLineId", "productId", "quantity", "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${a.packageId}::uuid, ${a.orderId}::uuid, ${a.orderLineId}::uuid, ${a.productId}::uuid, ${a.qty}::int, now(), now())
        ON CONFLICT ("packageId", "orderLineId") DO UPDATE
          SET "quantity" = "PackageItem"."quantity" + EXCLUDED."quantity", "updatedAt" = now()
        RETURNING "quantity"`;
      return rows[0].quantity;
    },
    setItemQuantity: (id: string, quantity: number) => db.packageItem.updateMany({ where: { ...org, id }, data: { quantity } }),
    deleteItem: (id: string) => db.packageItem.deleteMany({ where: { ...org, id } }),

    // ---- idempotency records ---------------------------------------------------------------
    insertIdempotency: (scope: string, key: string, requestHash: string) =>
      db.idempotencyRecord.create({ data: { organizationId: orgId, scope, key, requestHash } }),
    findIdempotency: (scope: string, key: string) => db.idempotencyRecord.findFirst({ where: { ...org, scope, key } }),
    setIdempotencyResource: (id: string, resourceType: string, resourceId: string) =>
      db.idempotencyRecord.updateMany({ where: { ...org, id }, data: { resourceType, resourceId } }),

    // ---- audit trail (append-only) -------------------------------------------------------
    recordEvent: (e: {
      sessionId: string;
      type: PackingEventType;
      packageId?: string;
      orderLineId?: string;
      productId?: string;
      quantityDelta?: number;
      quantityAfter?: number;
      detail?: string;
    }) => db.packingEvent.create({ data: { ...e, organizationId: orgId, actorUserId: ctx.userId } }),
  };
}

export type PackingRepo = ReturnType<typeof packingRepo>;

// Tenant-scoped inventory data access.
//
// CONCURRENCY RULES (docs/inventory.md): balances are changed ONLY by the single-statement,
// guarded functions below (receiveInto, takeOut, reserve, unreserve). Each statement checks its
// precondition in the WHERE clause and returns the new row, so there is never a read-then-write
// gap. CHECK constraints on InventoryBalance are the final backstop. Application code must not
// compute a new quantity and write it back.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";
import type { InventoryMovementType, ReservationStatus } from "@/generated/prisma/client";

export interface BalanceAfter {
  onHand: number;
  reserved: number;
}

export interface MovementRow {
  type: InventoryMovementType;
  warehouseId: string;
  productId: string;
  positionId: string;
  positionCode: string;
  counterpartPositionId?: string | null;
  counterpartPositionCode?: string | null;
  qtyDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
}

export function inventoryRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  const orgId = ctx.organizationId;

  return {
    // ---- guarded atomic balance changes (raw SQL, one statement each) --------------------

    /**
     * Add stock (creating the balance row on first receipt). Safe under concurrent first receipts.
     *
     * Writers that ADD stock to a position are serialized per position with a transaction-scoped
     * advisory lock. Without it, two concurrent first receipts of the SAME product could make
     * `INSERT ... ON CONFLICT` trip the one-product-per-position partial index instead of taking
     * the DO UPDATE path (ON CONFLICT only arbitrates one index), rejecting a valid request. With
     * the lock, a same-product writer always sees the committed row, and a different-product writer
     * always sees the real occupant. The partial unique index remains the backstop against any
     * writer that bypasses this function.
     *
     * Lock order: callers touch positions in ascending id order (see moveStock), so this advisory
     * lock sits at the same level as that position's row lock and cannot form a cycle.
     * The lock is released automatically when the surrounding transaction ends.
     */
    async receiveInto(a: { warehouseId: string; positionId: string; productId: string; qty: number }): Promise<BalanceAfter> {
      await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended('inventory-position:' || ${a.positionId}, 0))) AS l`;
      const rows = await db.$queryRaw<BalanceAfter[]>`
        INSERT INTO "InventoryBalance"
          ("id", "organizationId", "warehouseId", "positionId", "productId", "onHand", "reserved", "version", "createdAt", "updatedAt")
        VALUES
          (gen_random_uuid(), ${orgId}::uuid, ${a.warehouseId}::uuid, ${a.positionId}::uuid, ${a.productId}::uuid, ${a.qty}::int, 0, 1, now(), now())
        ON CONFLICT ("organizationId", "positionId", "productId") DO UPDATE
          SET "onHand" = "InventoryBalance"."onHand" + EXCLUDED."onHand",
              "version" = "InventoryBalance"."version" + 1,
              "updatedAt" = now()
        RETURNING "onHand", "reserved"`;
      return rows[0];
    },

    /** Remove stock only if AVAILABLE (onHand - reserved) covers it. null = not enough. */
    async takeOut(a: { positionId: string; productId: string; qty: number }): Promise<BalanceAfter | null> {
      const rows = await db.$queryRaw<BalanceAfter[]>`
        UPDATE "InventoryBalance"
           SET "onHand" = "onHand" - ${a.qty}::int, "version" = "version" + 1, "updatedAt" = now()
         WHERE "organizationId" = ${orgId}::uuid AND "positionId" = ${a.positionId}::uuid AND "productId" = ${a.productId}::uuid
           AND "onHand" - "reserved" >= ${a.qty}::int
        RETURNING "onHand", "reserved"`;
      return rows[0] ?? null;
    },

    /** Reserve stock only if AVAILABLE covers it. null = not enough. */
    async reserve(a: { positionId: string; productId: string; qty: number }): Promise<BalanceAfter | null> {
      const rows = await db.$queryRaw<BalanceAfter[]>`
        UPDATE "InventoryBalance"
           SET "reserved" = "reserved" + ${a.qty}::int, "version" = "version" + 1, "updatedAt" = now()
         WHERE "organizationId" = ${orgId}::uuid AND "positionId" = ${a.positionId}::uuid AND "productId" = ${a.productId}::uuid
           AND "onHand" - "reserved" >= ${a.qty}::int
        RETURNING "onHand", "reserved"`;
      return rows[0] ?? null;
    },

    /** Release reserved stock only if that much is reserved. null = would go negative. */
    async unreserve(a: { positionId: string; productId: string; qty: number }): Promise<BalanceAfter | null> {
      const rows = await db.$queryRaw<BalanceAfter[]>`
        UPDATE "InventoryBalance"
           SET "reserved" = "reserved" - ${a.qty}::int, "version" = "version" + 1, "updatedAt" = now()
         WHERE "organizationId" = ${orgId}::uuid AND "positionId" = ${a.positionId}::uuid AND "productId" = ${a.productId}::uuid
           AND "reserved" >= ${a.qty}::int
        RETURNING "onHand", "reserved"`;
      return rows[0] ?? null;
    },

    // ---- reads ---------------------------------------------------------------------------

    /** The product that currently has stock (onHand > 0) at a position, if any. */
    findOccupant: (positionId: string) =>
      db.inventoryBalance.findFirst({
        where: { ...org, positionId, onHand: { gt: 0 } },
        select: { productId: true, product: { select: { sku: true } } },
      }),

    getBalance: (positionId: string, productId: string) =>
      db.inventoryBalance.findFirst({ where: { ...org, positionId, productId } }),

    listStock: (f: { productId?: string; warehouseId?: string; positionId?: string; search?: string }) =>
      db.inventoryBalance.findMany({
        where: {
          ...org,
          OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }],
          ...(f.productId ? { productId: f.productId } : {}),
          ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
          ...(f.positionId ? { positionId: f.positionId } : {}),
          ...(f.search
            ? {
                product: {
                  OR: [
                    { sku: { contains: f.search, mode: "insensitive" } },
                    { name: { contains: f.search, mode: "insensitive" } },
                    { barcodes: { some: { barcode: f.search } } },
                  ],
                },
              }
            : {}),
        },
        include: {
          product: { select: { sku: true, name: true } },
          position: { select: { code: true, rack: { select: { warehouse: { select: { code: true } } } } } },
        },
        orderBy: [{ product: { sku: "asc" } }, { position: { code: "asc" } }],
        take: 500,
      }),

    listMovements: (f: { productId?: string; positionId?: string; limit: number }) =>
      db.inventoryMovement.findMany({
        where: { ...org, ...(f.productId ? { productId: f.productId } : {}), ...(f.positionId ? { positionId: f.positionId } : {}) },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: f.limit,
        include: { product: { select: { sku: true } }, operation: { select: { reason: true, actor: { select: { name: true } } } } },
      }),

    movementsOfOperation: (operationId: string) =>
      db.inventoryMovement.findMany({
        where: { ...org, operationId },
        orderBy: { createdAt: "asc" },
        include: { product: { select: { sku: true } }, operation: { select: { reason: true, actor: { select: { name: true } } } } },
      }),

    // ---- operations & ledger (append-only) -----------------------------------------------

    findOperationByKey: (idempotencyKey: string) => db.inventoryOperation.findFirst({ where: { ...org, idempotencyKey } }),

    createOperation: (data: {
      type: InventoryMovementType;
      idempotencyKey?: string;
      requestHash: string;
      reason?: string;
      refType?: string;
      refId?: string;
    }) => db.inventoryOperation.create({ data: { ...data, organizationId: orgId, actorUserId: ctx.userId } }),

    insertMovements: (operationId: string, rows: MovementRow[]) =>
      db.inventoryMovement.createMany({ data: rows.map((r) => ({ ...r, organizationId: orgId, operationId })) }),

    // ---- reservations --------------------------------------------------------------------

    createReservation: async (data: {
      id: string;
      refType?: string;
      refId?: string;
      note?: string;
      lines: { productId: string; positionId: string; positionCode: string; quantity: number }[];
    }) => {
      const reservation = await db.reservation.create({
        data: { id: data.id, organizationId: orgId, createdByUserId: ctx.userId, refType: data.refType, refId: data.refId, note: data.note },
      });
      await db.reservationLine.createMany({
        data: data.lines.map((l) => ({ ...l, organizationId: orgId, reservationId: reservation.id })),
      });
      return reservation;
    },

    /** ACTIVE -> RELEASED in one guarded statement, so a reservation can be released only once. */
    releaseIfActive: async (id: string) =>
      (await db.reservation.updateMany({ where: { ...org, id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date() } })).count,

    findReservation: (id: string) => db.reservation.findFirst({ where: { ...org, id }, include: { lines: { include: { product: { select: { sku: true } } } } } }),

    listReservations: (status?: ReservationStatus) =>
      db.reservation.findMany({
        where: { ...org, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
        take: 200,
        include: { lines: { include: { product: { select: { sku: true } } } } },
      }),
  };
}

export type InventoryRepo = ReturnType<typeof inventoryRepo>;

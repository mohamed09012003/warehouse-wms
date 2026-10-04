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

    /**
     * Picking: consume reserved stock. onHand AND reserved both fall by qty, only if that much is
     * reserved (and therefore on hand). null = the reserved stock is not there.
     */
    async consume(a: { positionId: string; productId: string; qty: number }): Promise<BalanceAfter | null> {
      const rows = await db.$queryRaw<BalanceAfter[]>`
        UPDATE "InventoryBalance"
           SET "onHand" = "onHand" - ${a.qty}::int, "reserved" = "reserved" - ${a.qty}::int,
               "version" = "version" + 1, "updatedAt" = now()
         WHERE "organizationId" = ${orgId}::uuid AND "positionId" = ${a.positionId}::uuid AND "productId" = ${a.productId}::uuid
           AND "reserved" >= ${a.qty}::int AND "onHand" >= ${a.qty}::int
        RETURNING "onHand", "reserved"`;
      return rows[0] ?? null;
    },

    /**
     * Allocation: reserve as much as is AVAILABLE, up to qty, in one statement. The balance row is
     * locked inside the statement, so the amount taken is exact even under concurrency.
     * null = nothing available.
     */
    async reserveUpTo(a: { positionId: string; productId: string; qty: number }): Promise<(BalanceAfter & { took: number }) | null> {
      const rows = await db.$queryRaw<(BalanceAfter & { took: number })[]>`
        WITH target AS (
          SELECT "id", "onHand" - "reserved" AS avail
            FROM "InventoryBalance"
           WHERE "organizationId" = ${orgId}::uuid AND "positionId" = ${a.positionId}::uuid AND "productId" = ${a.productId}::uuid
             AND "onHand" - "reserved" > 0
             FOR UPDATE
        )
        UPDATE "InventoryBalance" b
           SET "reserved" = b."reserved" + LEAST(${a.qty}::int, t.avail), "version" = b."version" + 1, "updatedAt" = now()
          FROM target t
         WHERE b."id" = t."id"
        RETURNING LEAST(${a.qty}::int, t.avail) AS "took", b."onHand", b."reserved"`;
      return rows[0] ?? null;
    },

    /** Positions holding available stock of a product, in a stable physical order (rack, level, bay, position). */
    availableStock: (productId: string) =>
      db.$queryRaw<{ positionId: string; positionCode: string; warehouseId: string; available: number }[]>`
        SELECT b."positionId", p."code" AS "positionCode", b."warehouseId", (b."onHand" - b."reserved") AS "available"
          FROM "InventoryBalance" b
          JOIN "Position" p ON p."id" = b."positionId"
          JOIN "Rack" r ON r."id" = p."rackId"
          JOIN "RackLevel" l ON l."id" = p."levelId"
          JOIN "Bay" y ON y."id" = p."bayId"
         WHERE b."organizationId" = ${orgId}::uuid AND b."productId" = ${productId}::uuid AND b."onHand" - b."reserved" > 0
         ORDER BY r."code", l."levelIndex", y."bayIndex", p."positionIndex", p."id"`,

    /** Row lock on a reservation (lock order: reservation before its balances). */
    async lockReservation(id: string): Promise<{ id: string; status: string; refType: string | null } | null> {
      const rows = await db.$queryRaw<{ id: string; status: string; refType: string | null }[]>`
        SELECT "id", "status"::text AS "status", "refType" FROM "Reservation"
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
      return rows[0] ?? null;
    },

    /** Add to a line's consumed quantity only if it stays within the reserved quantity. null = would exceed. */
    async consumeLine(id: string, qty: number) {
      const rows = await db.$queryRaw<
        { reservationId: string; productId: string; positionId: string; positionCode: string; quantity: number; consumedQuantity: number }[]
      >`
        UPDATE "ReservationLine"
           SET "consumedQuantity" = "consumedQuantity" + ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid AND "consumedQuantity" + ${qty}::int <= "quantity"
        RETURNING "reservationId", "productId", "positionId", "positionCode", "quantity", "consumedQuantity"`;
      return rows[0] ?? null;
    },

    /** ACTIVE -> CONSUMED once every line is fully consumed. Returns whether it closed. */
    async closeReservationIfConsumed(id: string): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "Reservation" r
           SET "status" = 'CONSUMED'::"ReservationStatus", "consumedAt" = now()
         WHERE r."organizationId" = ${orgId}::uuid AND r."id" = ${id}::uuid AND r."status" = 'ACTIVE'::"ReservationStatus"
           AND NOT EXISTS (SELECT 1 FROM "ReservationLine" l WHERE l."reservationId" = r."id" AND l."consumedQuantity" < l."quantity")`;
      return n > 0;
    },

    findReservationLine: (id: string) => db.reservationLine.findFirst({ where: { ...org, id } }),

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
      const lines = await db.reservationLine.findMany({ where: { ...org, reservationId: reservation.id } });
      return { ...reservation, lines };
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

// Tenant-scoped data access for waves, pick tasks and the FULFILMENT side of orders
// (allocatedQty / pickedQty / fulfilment status). Stock itself is never touched here.
//
// LOCK ORDER (every multi-row picking flow follows it, so flows cannot deadlock each other):
//   Wave  ->  Order  ->  PickTask  ->  Reservation  ->  InventoryBalance  ->  OrderLine updates
// Within one type, rows are locked in ascending id order. The inventory module takes
// Reservation -> InventoryBalance (see stockTx.ts), which is a suffix of this order.
// Quantities change only through guarded single-statement UPDATEs; CHECK constraints are the backstop.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";
import type { OrderStatus, PickTaskStatus, WaveStatus } from "@/generated/prisma/client";

export interface LockedWave {
  id: string;
  status: WaveStatus;
  number: number;
}
export interface LockedOrder {
  id: string;
  status: OrderStatus;
  orderNumber: string;
}
export interface LockedTask {
  id: string;
  waveId: string | null;
  orderId: string;
  orderLineId: string;
  productId: string;
  positionId: string;
  positionCode: string;
  reservationId: string;
  reservationLineId: string;
  quantity: number;
  pickedQty: number;
  status: PickTaskStatus;
}

export function pickingRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  const orgId = ctx.organizationId;

  return {
    // ---- locks (SELECT ... FOR UPDATE) ---------------------------------------------------

    /** Lock waves in ascending id order. */
    async lockWaves(ids: string[]): Promise<LockedWave[]> {
      const sorted = [...new Set(ids)].sort();
      const out: LockedWave[] = [];
      for (const id of sorted) {
        const rows = await db.$queryRaw<LockedWave[]>`
          SELECT "id", "status"::text AS "status", "number" FROM "PickingWave"
           WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
        if (rows[0]) out.push(rows[0]);
      }
      return out;
    },

    /** Lock orders in ascending id order. */
    async lockOrders(ids: string[]): Promise<LockedOrder[]> {
      const sorted = [...new Set(ids)].sort();
      const out: LockedOrder[] = [];
      for (const id of sorted) {
        const rows = await db.$queryRaw<LockedOrder[]>`
          SELECT "id", "status"::text AS "status", "orderNumber" FROM "Order"
           WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
        if (rows[0]) out.push(rows[0]);
      }
      return out;
    },

    /** Lock tasks in ascending id order and return their current state. */
    async lockTasks(ids: string[]): Promise<LockedTask[]> {
      const sorted = [...new Set(ids)].sort();
      const out: LockedTask[] = [];
      for (const id of sorted) {
        const rows = await db.$queryRaw<LockedTask[]>`
          SELECT "id", "waveId", "orderId", "orderLineId", "productId", "positionId", "positionCode",
                 "reservationId", "reservationLineId", "quantity", "pickedQty", "status"::text AS "status"
            FROM "PickTask" WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
        if (rows[0]) out.push(rows[0]);
      }
      return out;
    },

    // ---- reads ---------------------------------------------------------------------------

    findOrder: (id: string) => db.order.findFirst({ where: { ...org, id }, select: { id: true, orderNumber: true, status: true } }),
    taskIdsOfOrder: (orderId: string) => db.pickTask.findMany({ where: { ...org, orderId }, select: { id: true, waveId: true, status: true } }),
    taskIdsOfWave: (waveId: string) => db.pickTask.findMany({ where: { ...org, waveId }, select: { id: true, orderId: true, status: true } }),
    findTask: (id: string) => db.pickTask.findFirst({ where: { ...org, id } }),
    orderLines: (orderId: string) => db.orderLine.findMany({ where: { ...org, orderId }, orderBy: { lineNo: "asc" }, include: { product: { select: { sku: true } } } }),
    findWave: (id: string) => db.pickingWave.findFirst({ where: { ...org, id } }),
    openTaskCountOfWave: (waveId: string) => db.pickTask.count({ where: { ...org, waveId, status: { in: ["PENDING", "IN_PROGRESS"] } } }),

    // ---- order fulfilment (guarded) ------------------------------------------------------

    /** allocated += qty, only while allocated + qty <= requested. */
    async increaseAllocated(lineId: string, qty: number): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "OrderLine" SET "allocatedQty" = "allocatedQty" + ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${lineId}::uuid AND "allocatedQty" + ${qty}::int <= "requestedQty"`;
      return n === 1;
    },
    /** allocated -= qty, only while allocated - qty >= picked. */
    async decreaseAllocated(lineId: string, qty: number): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "OrderLine" SET "allocatedQty" = "allocatedQty" - ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${lineId}::uuid AND "allocatedQty" - ${qty}::int >= "pickedQty"`;
      return n === 1;
    },
    /** picked += qty, only while picked + qty <= allocated (and therefore <= requested). */
    async increasePicked(lineId: string, qty: number): Promise<boolean> {
      const n = await db.$executeRaw`
        UPDATE "OrderLine" SET "pickedQty" = "pickedQty" + ${qty}::int
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${lineId}::uuid AND "pickedQty" + ${qty}::int <= "allocatedQty"`;
      return n === 1;
    },
    setOrderStatus: (id: string, status: OrderStatus) => db.order.updateMany({ where: { ...org, id }, data: { status } }),

    // ---- tasks ---------------------------------------------------------------------------

    createTask: (data: {
      orderId: string;
      orderLineId: string;
      productId: string;
      positionId: string;
      positionCode: string;
      reservationId: string;
      reservationLineId: string;
      quantity: number;
    }) => db.pickTask.create({ data: { ...data, organizationId: orgId } }),

    /**
     * picked += qty on a PENDING/IN_PROGRESS task, only while picked + qty <= quantity. The status
     * becomes COMPLETED when the task is fully picked, otherwise IN_PROGRESS. null = not allowed now.
     */
    async increaseTaskPicked(id: string, qty: number) {
      const rows = await db.$queryRaw<{ pickedQty: number; quantity: number; status: PickTaskStatus }[]>`
        UPDATE "PickTask"
           SET "pickedQty" = "pickedQty" + ${qty}::int,
               "status" = (CASE WHEN "pickedQty" + ${qty}::int = "quantity" THEN 'COMPLETED' ELSE 'IN_PROGRESS' END)::"PickTaskStatus",
               "completedAt" = CASE WHEN "pickedQty" + ${qty}::int = "quantity" THEN now() ELSE "completedAt" END,
               "updatedAt" = now()
         WHERE "organizationId" = ${orgId}::uuid AND "id" = ${id}::uuid
           AND "status" IN ('PENDING'::"PickTaskStatus", 'IN_PROGRESS'::"PickTaskStatus")
           AND "pickedQty" + ${qty}::int <= "quantity"
        RETURNING "pickedQty", "quantity", "status"::text AS "status"`;
      return rows[0] ?? null;
    },

    /** Cancel open tasks (pending or in progress). Their pickedQty is kept. */
    cancelTasks: (ids: string[]) =>
      db.pickTask.updateMany({ where: { ...org, id: { in: ids }, status: { in: ["PENDING", "IN_PROGRESS"] } }, data: { status: "CANCELLED" } }),

    /** Put unassigned PENDING tasks into a wave. Returns how many were assigned. */
    async assignTasksToWave(taskIds: string[], waveId: string): Promise<number> {
      return (await db.pickTask.updateMany({ where: { ...org, id: { in: taskIds }, waveId: null, status: "PENDING" }, data: { waveId } })).count;
    },

    // ---- waves ---------------------------------------------------------------------------

    async createWave(note: string | null): Promise<{ id: string; number: number }> {
      // Per-organization sequence; the unique (organizationId, number) index settles races, we retry.
      for (let attempt = 0; ; attempt++) {
        const max = await db.pickingWave.aggregate({ where: org, _max: { number: true } });
        try {
          return await db.pickingWave.create({
            data: { organizationId: orgId, number: (max._max.number ?? 0) + 1, note, createdByUserId: ctx.userId },
            select: { id: true, number: true },
          });
        } catch (error) {
          if ((error as { code?: unknown })?.code !== "P2002" || attempt >= 5) throw error;
        }
      }
    },

    /** from -> to in one guarded statement (`stamp` names the timestamp column to set). Returns rows changed. */
    async transitionWave(id: string, from: WaveStatus[], to: WaveStatus, stamp: "releasedAt" | "startedAt" | "completedAt" | "cancelledAt") {
      return (await db.pickingWave.updateMany({ where: { ...org, id, status: { in: from } }, data: { status: to, [stamp]: new Date() } })).count;
    },

    listWaves: () =>
      db.pickingWave.findMany({
        where: org,
        orderBy: [{ number: "desc" }],
        take: 200,
        include: { tasks: { select: { status: true, quantity: true, pickedQty: true, orderId: true } } },
      }),

    waveWithTasks: (id: string) =>
      db.pickingWave.findFirst({
        where: { ...org, id },
        include: {
          tasks: {
            orderBy: [{ positionCode: "asc" }, { id: "asc" }],
            include: { order: { select: { orderNumber: true } }, product: { select: { sku: true, name: true } } },
          },
        },
      }),

    taskDetail: (id: string) =>
      db.pickTask.findFirst({
        where: { ...org, id },
        include: {
          order: { select: { orderNumber: true, status: true } },
          product: { select: { sku: true, name: true } },
          wave: { select: { number: true, status: true } },
          orderLine: { select: { requestedQty: true, allocatedQty: true, pickedQty: true } },
        },
      }),

    tasksOfOrderDetailed: (orderId: string) =>
      db.pickTask.findMany({
        where: { ...org, orderId },
        orderBy: [{ positionCode: "asc" }, { id: "asc" }],
        include: { wave: { select: { number: true, status: true } }, product: { select: { sku: true } } },
      }),

    tasksList: (f: { status?: PickTaskStatus; waveId?: string }) =>
      db.pickTask.findMany({
        where: { ...org, ...(f.status ? { status: f.status } : {}), ...(f.waveId ? { waveId: f.waveId } : {}) },
        orderBy: [{ positionCode: "asc" }, { id: "asc" }],
        take: 500,
        include: { order: { select: { orderNumber: true } }, product: { select: { sku: true, name: true } }, wave: { select: { number: true, status: true } } },
      }),

    /** Orders in the picking phase that still have unassigned PENDING tasks (eligible for a wave). */
    eligibleOrders: () =>
      db.order.findMany({
        where: { ...org, status: { in: ["PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING"] }, tasks: { some: { waveId: null, status: "PENDING" } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, orderNumber: true, status: true, tasks: { where: { waveId: null, status: "PENDING" }, select: { quantity: true } } },
      }),
  };
}

export type PickingRepo = ReturnType<typeof pickingRepo>;

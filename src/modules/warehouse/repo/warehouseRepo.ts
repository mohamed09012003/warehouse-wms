// Tenant-scoped data access for the warehouse module. Every query is filtered by the
// context's organizationId. `DbClient` may be a transaction client.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";
import type { Prisma } from "@/generated/prisma/client";
import { PositionInUseError } from "@/lib/errors";

export function warehouseRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  return {
    // ---- warehouses
    list: () =>
      db.warehouse.findMany({
        where: org,
        orderBy: { code: "asc" },
        include: { _count: { select: { racks: true, objects: true } } },
      }),
    findById: (id: string) => db.warehouse.findFirst({ where: { ...org, id } }),
    create: (data: { code: string; name: string; widthMm: number; lengthMm: number }) =>
      db.warehouse.create({ data: { ...data, organizationId: ctx.organizationId } }),
    /** Atomic compare-and-bump of layoutVersion; returns the number of rows updated (0 = stale/missing). */
    bumpVersion: async (id: string, expected: number, data: { name: string; widthMm: number; lengthMm: number }) =>
      (
        await db.warehouse.updateMany({
          where: { ...org, id, layoutVersion: expected },
          data: { ...data, layoutVersion: { increment: 1 } },
        })
      ).count,

    // ---- pallet types
    createPalletType: (data: { name: string; widthMm: number; lengthMm: number; heightMm?: number | null; maxLoadG?: number | null }) =>
      db.palletType.create({ data: { ...data, organizationId: ctx.organizationId } }),
    palletTypes: () => db.palletType.findMany({ where: { ...org, archivedAt: null }, orderBy: { name: "asc" } }),

    // ---- floor-plan objects
    objects: (warehouseId: string) => db.warehouseObject.findMany({ where: { ...org, warehouseId }, orderBy: { createdAt: "asc" } }),
    createObjects: (warehouseId: string, rows: Omit<Prisma.WarehouseObjectCreateManyInput, "organizationId" | "warehouseId">[]) =>
      db.warehouseObject.createMany({ data: rows.map((r) => ({ ...r, organizationId: ctx.organizationId, warehouseId })) }),
    updateObject: (id: string, data: Prisma.WarehouseObjectUpdateManyMutationInput) =>
      db.warehouseObject.updateMany({ where: { ...org, id }, data }),
    deleteObjects: (ids: string[]) => db.warehouseObject.deleteMany({ where: { ...org, id: { in: ids } } }),

    // ---- racks
    racks: (warehouseId: string) =>
      db.rack.findMany({
        where: { ...org, warehouseId },
        orderBy: { code: "asc" },
        include: { levels: { orderBy: { levelIndex: "asc" } }, bays: { orderBy: { bayIndex: "asc" } } },
      }),
    findRack: (warehouseId: string, rackId: string) => db.rack.findFirst({ where: { ...org, warehouseId, id: rackId } }),
    createRack: (warehouseId: string, data: Omit<Prisma.RackUncheckedCreateInput, "organizationId" | "warehouseId">) =>
      db.rack.create({ data: { ...data, organizationId: ctx.organizationId, warehouseId } }),
    updateRack: (id: string, data: Prisma.RackUpdateManyMutationInput) => db.rack.updateMany({ where: { ...org, id }, data }),
    /** Cascades to the rack's levels, bays and positions. */
    deleteRacks: (ids: string[]) => db.rack.deleteMany({ where: { ...org, id: { in: ids } } }),

    // ---- rack structure
    levels: (rackId: string) => db.rackLevel.findMany({ where: { ...org, rackId }, orderBy: { levelIndex: "asc" } }),
    bays: (rackId: string) => db.bay.findMany({ where: { ...org, rackId }, orderBy: { bayIndex: "asc" }, include: { palletType: true } }),
    positions: (rackId: string) =>
      db.position.findMany({ where: { ...org, rackId }, select: { id: true, levelId: true, bayId: true, positionIndex: true, code: true, palletTypeId: true } }),
    positionsDetailed: (rackId: string) =>
      db.position.findMany({
        where: { ...org, rackId },
        include: { level: { select: { levelIndex: true } }, bay: { select: { bayIndex: true } } },
      }),
    createLevel: (rackId: string, data: { levelIndex: number; elevationMm: number; clearanceMm: number; maxLoadG: number | null }) =>
      db.rackLevel.create({ data: { ...data, organizationId: ctx.organizationId, rackId } }),
    updateLevel: (id: string, data: { elevationMm: number; clearanceMm: number; maxLoadG: number | null }) =>
      db.rackLevel.updateMany({ where: { ...org, id }, data }),
    deleteLevels: (ids: string[]) => db.rackLevel.deleteMany({ where: { ...org, id: { in: ids } } }),
    createBay: (
      rackId: string,
      data: { bayIndex: number; offsetMm: number; widthMm: number; positionCount: number; palletTypeId: string | null },
    ) => db.bay.create({ data: { ...data, organizationId: ctx.organizationId, rackId } }),
    updateBay: (id: string, data: { offsetMm: number; widthMm: number; positionCount: number; palletTypeId: string | null }) =>
      db.bay.updateMany({ where: { ...org, id }, data }),
    deleteBays: (ids: string[]) => db.bay.deleteMany({ where: { ...org, id: { in: ids } } }),
    createPositions: (
      warehouseId: string,
      rackId: string,
      rows: { levelId: string; bayId: string; positionIndex: number; code: string; palletTypeId: string | null }[],
    ) =>
      db.position.createMany({
        data: rows.map((r) => ({ ...r, organizationId: ctx.organizationId, warehouseId, rackId })),
      }),
    updatePosition: (id: string, data: { code: string; palletTypeId: string | null }) =>
      db.position.updateMany({ where: { ...org, id }, data }),
    /** Tenant-scoped lookup used by inventory (ids from other organizations are simply absent). */
    positionsByIds: (ids: string[]) =>
      db.position.findMany({ where: { ...org, id: { in: ids } }, select: { id: true, code: true, warehouseId: true } }),
    searchPositions: (warehouseId: string, prefix: string, limit: number) =>
      db.position.findMany({
        where: { ...org, warehouseId, ...(prefix ? { code: { startsWith: prefix } } : {}) },
        orderBy: { code: "asc" },
        take: limit,
        select: { id: true, code: true },
      }),
    /**
     * The ONLY way positions are removed. A position that holds stock or reservations
     * (onHand > 0 or reserved > 0) is never deleted: this throws PositionInUseError and the
     * caller's transaction rolls back. Empty balance rows (0/0) are cleaned up first because the
     * balance -> position foreign key is RESTRICT. The FK is also the backstop for a receive that
     * races with this delete.
     */
    removePositions: async (ids: string[]) => {
      if (ids.length === 0) return { count: 0 };
      const occupied = await db.inventoryBalance.findMany({
        where: { ...org, positionId: { in: ids }, OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }] },
        select: { position: { select: { code: true } } },
      });
      if (occupied.length > 0) {
        const codes = [...new Set(occupied.map((b) => b.position.code))].sort();
        throw new PositionInUseError(
          `Cannot remove positions that hold stock: ${codes.slice(0, 5).join(", ")}${codes.length > 5 ? `, and ${codes.length - 5} more` : ""}`,
          { positions: codes },
        );
      }
      await db.inventoryBalance.deleteMany({ where: { ...org, positionId: { in: ids }, onHand: 0, reserved: 0 } });
      try {
        return await db.position.deleteMany({ where: { ...org, id: { in: ids } } });
      } catch (error) {
        if ((error as { code?: unknown })?.code === "P2003") {
          throw new PositionInUseError("Cannot remove positions: stock was just placed on them");
        }
        throw error;
      }
    },
  };
}

export type WarehouseRepo = ReturnType<typeof warehouseRepo>;

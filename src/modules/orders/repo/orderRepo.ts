// Tenant-scoped order access (entry and reads). Fulfilment columns (allocatedQty, pickedQty and the
// fulfilment statuses) are changed by the picking module's repository inside its transactions.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";
import type { OrderStatus } from "@/generated/prisma/client";

export function orderRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  const include = { lines: { orderBy: { lineNo: "asc" as const }, include: { product: { select: { sku: true, name: true } } } } };
  return {
    list: (f: { status?: OrderStatus; search?: string }) =>
      db.order.findMany({
        where: {
          ...org,
          ...(f.status ? { status: f.status } : {}),
          ...(f.search
            ? { OR: [{ orderNumber: { contains: f.search.toUpperCase() } }, { externalRef: { contains: f.search, mode: "insensitive" as const } }] }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 300,
        include,
      }),
    findById: (id: string) => db.order.findFirst({ where: { ...org, id }, include }),
    findByOrderNumber: (orderNumber: string) =>
      db.order.findFirst({ where: { ...org, orderNumber }, select: { id: true, orderNumber: true, externalRef: true, status: true } }),
    create: async (data: {
      orderNumber: string;
      status: OrderStatus;
      externalRef: string | null;
      note: string | null;
      lines: { productId: string; quantity: number }[];
    }) => {
      const order = await db.order.create({
        data: {
          organizationId: ctx.organizationId,
          orderNumber: data.orderNumber,
          status: data.status,
          externalRef: data.externalRef,
          note: data.note,
          createdByUserId: ctx.userId,
        },
      });
      await db.orderLine.createMany({
        data: data.lines.map((l, i) => ({
          organizationId: ctx.organizationId,
          orderId: order.id,
          lineNo: i + 1,
          productId: l.productId,
          requestedQty: l.quantity,
        })),
      });
      return order;
    },
    /** DRAFT -> READY in one guarded statement. Returns rows changed. */
    markReady: async (id: string) =>
      (await db.order.updateMany({ where: { ...org, id, status: "DRAFT" }, data: { status: "READY" } })).count,
  };
}

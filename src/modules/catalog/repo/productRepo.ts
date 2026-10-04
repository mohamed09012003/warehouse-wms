// Tenant-scoped product access. Every query is filtered by the context's organizationId.
import { prisma } from "@/server/db/client";
import type { DbClient } from "@/server/db";
import type { TenantContext } from "@/modules/tenancy";

export function productRepo(ctx: TenantContext, db: DbClient = prisma) {
  const org = { organizationId: ctx.organizationId };
  return {
    list: (opts: { search?: string; includeInactive?: boolean }) =>
      db.product.findMany({
        where: {
          ...org,
          ...(opts.includeInactive ? {} : { active: true }),
          ...(opts.search
            ? {
                OR: [
                  { sku: { contains: opts.search, mode: "insensitive" } },
                  { name: { contains: opts.search, mode: "insensitive" } },
                  { barcodes: { some: { barcode: opts.search } } },
                ],
              }
            : {}),
        },
        orderBy: { sku: "asc" },
        take: 500,
        include: { _count: { select: { barcodes: true } } },
      }),
    findById: (id: string) => db.product.findFirst({ where: { ...org, id }, include: { barcodes: { orderBy: { createdAt: "asc" } } } }),
    /** Resolve a typed or scanned value: the SKU (case-insensitive) or any barcode of the organization. */
    findByCode: (code: string) =>
      db.product.findFirst({
        where: { ...org, OR: [{ sku: code.toUpperCase() }, { barcodes: { some: { barcode: code } } }] },
        select: { id: true, sku: true },
      }),
    findBySku: (sku: string) => db.product.findFirst({ where: { ...org, sku }, include: { barcodes: { orderBy: { createdAt: "asc" } } } }),
    /** The product a barcode is assigned to in this organization, if any. */
    findBarcodeOwner: (barcode: string) => db.productBarcode.findFirst({ where: { ...org, barcode }, select: { productId: true } }),
    findManyByIds: (ids: string[]) => db.product.findMany({ where: { ...org, id: { in: ids } } }),
    create: (data: { sku: string; name: string; description: string | null }) =>
      db.product.create({ data: { ...data, organizationId: ctx.organizationId } }),
    update: (id: string, data: { name?: string; description?: string | null; active?: boolean }) =>
      db.product.updateMany({ where: { ...org, id }, data }),
    addBarcode: (productId: string, barcode: string) =>
      db.productBarcode.create({ data: { organizationId: ctx.organizationId, productId, barcode } }),
    removeBarcode: (productId: string, barcodeId: string) =>
      db.productBarcode.deleteMany({ where: { ...org, productId, id: barcodeId } }),
  };
}

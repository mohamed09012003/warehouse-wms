// Tenant- and integration-scoped access to ExternalRef (external id <-> WMS entity). Takes a client so
// inbound handlers can write references in the same transaction as the entity they map.
import type { DbClient } from "@/server/db";
import { prisma } from "@/server/db/client";

export function externalRefRepo(organizationId: string, integrationId: string, db: DbClient = prisma) {
  const scope = { organizationId, integrationId };
  return {
    find: (entityType: "PRODUCT" | "ORDER", externalId: string) =>
      db.externalRef.findFirst({ where: { ...scope, entityType, externalId }, select: { productId: true, orderId: true, externalId: true } }),
    findByProduct: (productId: string) => db.externalRef.findFirst({ where: { ...scope, productId }, select: { externalId: true } }),
    findByOrder: (orderId: string) => db.externalRef.findFirst({ where: { ...scope, orderId }, select: { externalId: true } }),
    insertProduct: (externalId: string, productId: string) =>
      db.externalRef.create({ data: { ...scope, entityType: "PRODUCT", externalId, productId }, select: { id: true } }),
    insertOrder: (externalId: string, orderId: string) =>
      db.externalRef.create({ data: { ...scope, entityType: "ORDER", externalId, orderId }, select: { id: true } }),
  };
}

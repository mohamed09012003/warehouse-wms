// Inbound handlers of the generic webhook adapter. They TRANSLATE external DTOs into calls to the
// core services (catalog, orders, picking's cancelOrder) and keep the ExternalRef mapping. They contain
// no WMS business rules and never touch inventory, reservations, tasks or packing tables.
import { resolveProductCode, upsertProduct } from "@/modules/catalog";
import { createOrder, findOrderByNumber, getOrder } from "@/modules/orders";
import { cancelOrder } from "@/modules/picking";
import { InboundRejectError } from "../../core/errors";
import type { HandlerResult, InboundHandler } from "../../core/types";
import { externalRefRepo } from "../../repo/externalRefRepo";
import {
  orderCancelSchema,
  orderCreateSchema,
  productUpsertSchema,
  type OrderCancelData,
  type OrderCreateData,
  type ProductUpsertData,
} from "./inboundSchemas";

const productUpsert: InboundHandler<ProductUpsertData> = {
  schema: productUpsertSchema,
  async handle({ ctx, tx, integration }, data): Promise<HandlerResult> {
    const refs = externalRefRepo(ctx.organizationId, integration.id, tx);
    const ref = await refs.find("PRODUCT", data.externalId);
    const { product } = await upsertProduct(
      ctx,
      { sku: data.sku, name: data.name, description: data.description, barcodes: data.barcodes },
      { tx, productId: ref?.productId ?? undefined },
    );
    if (!ref) {
      const mapped = await refs.findByProduct(product.id);
      if (mapped && mapped.externalId !== data.externalId) {
        throw new InboundRejectError("PRODUCT_ALREADY_MAPPED", `SKU ${product.sku} is already linked to a different external product`);
      }
      await refs.insertProduct(data.externalId, product.id);
    }
    return { resultType: "PRODUCT", resultId: product.id };
  },
};

const orderCreate: InboundHandler<OrderCreateData> = {
  schema: orderCreateSchema,
  async handle({ ctx, tx, integration }, data): Promise<HandlerResult> {
    const refs = externalRefRepo(ctx.organizationId, integration.id, tx);
    // Already imported (a different event id for the same external order, or a retry): nothing to do.
    const existing = await refs.find("ORDER", data.externalId);
    if (existing?.orderId) return { resultType: "ORDER", resultId: existing.orderId };

    const orderNumber = data.orderNumber ?? data.externalId;
    if (await findOrderByNumber(ctx, orderNumber, tx)) {
      throw new InboundRejectError("ORDER_NUMBER_EXISTS", `An order with number ${orderNumber.toUpperCase()} already exists`);
    }

    const lines: { productId: string; quantity: number }[] = [];
    for (const line of data.lines) {
      let productId: string | null = null;
      if (line.externalProductId) productId = (await refs.find("PRODUCT", line.externalProductId))?.productId ?? null;
      if (!productId && line.sku) productId = (await resolveProductCode(ctx, line.sku))?.id ?? null;
      if (!productId) {
        throw new InboundRejectError("UNKNOWN_PRODUCT", `No product matches ${line.externalProductId ? `external product ${line.externalProductId}` : `SKU ${line.sku}`}`);
      }
      lines.push({ productId, quantity: line.quantity });
    }

    const order = await createOrder(
      ctx,
      { orderNumber, externalRef: data.externalId, note: data.note, ready: data.ready ?? true, lines },
      { tx },
    );
    await refs.insertOrder(data.externalId, order.id);
    return { resultType: "ORDER", resultId: order.id };
  },
};

const orderCancel: InboundHandler<OrderCancelData> = {
  schema: orderCancelSchema,
  async handle({ ctx, tx, integration, inboundEventId }, data): Promise<HandlerResult> {
    const ref = await externalRefRepo(ctx.organizationId, integration.id, tx).find("ORDER", data.externalId);
    if (!ref?.orderId) throw new InboundRejectError("UNKNOWN_ORDER", `No order is linked to external order ${data.externalId}`);
    const order = await getOrder(ctx, ref.orderId);
    // Cancelling an already cancelled order is a success (this is what makes retries and replays safe).
    if (order.status === "CANCELLED") return { resultType: "ORDER", resultId: order.id };
    // The core cancel runs its own transaction (it releases reservations through the inventory module).
    // PACKING/PACKED (and other non-cancellable) orders raise INVALID_STATE, which becomes a REJECTED event
    // with nothing changed. The idempotency key is stable per inbound event.
    await cancelOrder(ctx, { orderId: order.id, idempotencyKey: `inbound-cancel-${inboundEventId}` });
    return { resultType: "ORDER", resultId: order.id };
  },
};

export const genericWebhookHandlers: Record<string, InboundHandler> = {
  "product.upsert": productUpsert,
  "order.create": orderCreate,
  "order.cancel": orderCancel,
};

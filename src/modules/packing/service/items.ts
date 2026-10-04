// Package contents. THE INVARIANT: for every order line, packed <= picked.
//
// It is enforced by a guarded single-statement update on OrderLine.packedQty
// (`packedQty + q <= pickedQty`) inside the transaction, so concurrent additions can never exceed
// what was picked; the CHECK constraint is the backstop. Item rows and the packed counter change
// together or not at all. Nothing here touches inventory or picking.
import { InvalidStateError, NotFoundError, PackQuantityError, ConflictError, WrongProductError, parseInput } from "@/lib/errors";
import { resolveProductCode } from "@/modules/catalog";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { remainingToPack } from "../domain/progress";
import { packingRepo } from "../repo/packingRepo";
import { addItemSchema, removeItemSchema, setItemQuantitySchema } from "../schemas";
import type { PackingResultDto } from "../types";
import { packingMutation } from "./mutation";
import { lockOpenPackage } from "./packages";

/** Add picked quantity to an OPEN package (a scanner sends the same request: product code + quantity). */
export async function addPackageItem(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { idempotencyKey, ...input } = parseInput(addItemSchema, raw);
  const pkg0 = await packingRepo(ctx).findPackage(input.packageId);
  if (!pkg0) throw new NotFoundError("Package not found");
  const product = await resolveProductCode(ctx, input.productCode);
  if (!product) throw new WrongProductError(`Unknown product "${input.productCode}".`);

  return packingMutation(ctx, {
    scope: "packing.addItem",
    idempotencyKey,
    request: input,
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, pkg0.sessionId, input.packageId);

      // The line must belong to THIS order, and the scanned product must be that line's product.
      const lines = await repo.orderLines(session.orderId);
      const line = input.orderLineId ? lines.find((l) => l.id === input.orderLineId) : lines.find((l) => l.productId === product.id);
      if (!line) {
        throw new WrongProductError(input.orderLineId ? "That order line does not belong to this order." : `Product ${product.sku} is not on this order.`);
      }
      if (line.productId !== product.id) throw new WrongProductError(`${input.productCode} is not the product of that order line (${line.product.sku}).`);

      // Guarded: packed + qty <= picked. Concurrent adds cannot both take the same remaining quantity.
      if (!(await repo.increasePacked(line.id, input.quantity))) {
        const fresh = (await repo.orderLines(session.orderId)).find((l) => l.id === line.id)!;
        const left = Math.max(remainingToPack(fresh), 0);
        throw new PackQuantityError(`Only ${left} of ${line.product.sku} picked but not yet packed (you entered ${input.quantity}).`, { remaining: left });
      }
      const quantity = await repo.upsertItem({ packageId: pkg.id, orderId: session.orderId, orderLineId: line.id, productId: line.productId, qty: input.quantity });
      await repo.recordEvent({
        sessionId: session.id,
        type: "ITEM_ADDED",
        packageId: pkg.id,
        orderLineId: line.id,
        productId: line.productId,
        quantityDelta: input.quantity,
        quantityAfter: quantity,
      });
      return { sessionId: session.id, packageId: pkg.id };
    },
  });
}

/** Change the quantity of an item in an OPEN package (up is limited by the picked-but-unpacked quantity). */
export async function setPackageItemQuantity(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { idempotencyKey, itemId, quantity } = parseInput(setItemQuantitySchema, raw);
  const item0 = await packingRepo(ctx).findItem(itemId);
  if (!item0) throw new NotFoundError("Package item not found");

  return packingMutation(ctx, {
    scope: "packing.setItemQuantity",
    idempotencyKey,
    request: { itemId, quantity },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, item0.package.sessionId, item0.package.id);
      const item = await repo.findItem(itemId); // re-read under the lock
      if (!item || item.packageId !== pkg.id) throw new NotFoundError("Package item not found");

      const delta = quantity - item.quantity;
      if (delta > 0 && !(await repo.increasePacked(item.orderLineId, delta))) {
        const line = (await repo.orderLines(session.orderId)).find((l) => l.id === item.orderLineId)!;
        const left = Math.max(remainingToPack(line), 0);
        throw new PackQuantityError(`Only ${left} more of ${line.product.sku} can be packed (picked but not yet packed).`, { remaining: left });
      }
      if (delta < 0 && !(await repo.decreasePacked(item.orderLineId, -delta))) throw new ConflictError("Packed quantities are inconsistent; the change was aborted");
      if (delta !== 0) {
        await repo.setItemQuantity(itemId, quantity);
        await repo.recordEvent({
          sessionId: session.id,
          type: "ITEM_CHANGED",
          packageId: pkg.id,
          orderLineId: item.orderLineId,
          productId: item.productId,
          quantityDelta: delta,
          quantityAfter: quantity,
        });
      }
      return { sessionId: session.id, packageId: pkg.id };
    },
  });
}

/** Remove an item from an OPEN package; its quantity becomes unpacked again. */
export async function removePackageItem(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { idempotencyKey, itemId } = parseInput(removeItemSchema, raw);
  const item0 = await packingRepo(ctx).findItem(itemId);
  if (!item0) throw new NotFoundError("Package item not found");

  return packingMutation(ctx, {
    scope: "packing.removeItem",
    idempotencyKey,
    request: { itemId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, item0.package.sessionId, item0.package.id);
      const item = await repo.findItem(itemId);
      if (!item || item.packageId !== pkg.id) throw new InvalidStateError("This item was already removed.");
      if (!(await repo.decreasePacked(item.orderLineId, item.quantity))) throw new ConflictError("Packed quantities are inconsistent; the change was aborted");
      await repo.deleteItem(itemId);
      await repo.recordEvent({
        sessionId: session.id,
        type: "ITEM_REMOVED",
        packageId: pkg.id,
        orderLineId: item.orderLineId,
        productId: item.productId,
        quantityDelta: -item.quantity,
        quantityAfter: 0,
      });
      return { sessionId: session.id, packageId: pkg.id };
    },
  });
}

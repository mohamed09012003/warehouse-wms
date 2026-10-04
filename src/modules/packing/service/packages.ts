// Package lifecycle:   OPEN --complete--> COMPLETED (immutable)      OPEN --cancel--> CANCELLED
// Every package/item change locks Session -> Package (see packingRepo), checks that the session AND
// the package are still OPEN, and changes only packing records: never inventory, never picking.
import { InvalidStateError, NotFoundError, ConflictError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import type { Tx } from "@/server/db";
import { packingRepo, type LockedPackage, type LockedSession } from "../repo/packingRepo";
import { createPackageSchema, packageActionSchema, updatePackageSchema } from "../schemas";
import type { PackingResultDto } from "../types";
import { packingMutation } from "./mutation";

/**
 * Lock session then package and verify both are OPEN and belong together. Shared by every package
 * and item operation so the checks (and the lock order) cannot drift apart.
 */
export async function lockOpenPackage(
  ctx: TenantContext,
  tx: Tx,
  sessionId: string,
  packageId: string,
): Promise<{ session: LockedSession; pkg: LockedPackage }> {
  const repo = packingRepo(ctx, tx);
  const session = await repo.lockSession(sessionId);
  if (!session) throw new NotFoundError("Packing session not found");
  if (session.status !== "OPEN") throw new InvalidStateError(`The packing session is ${session.status.toLowerCase()}; it can no longer be changed.`);
  const pkg = await repo.lockPackage(packageId);
  if (!pkg || pkg.sessionId !== sessionId) throw new NotFoundError("Package not found");
  if (pkg.status === "COMPLETED") throw new InvalidStateError(`Package ${pkg.packageNumber} is completed and can no longer be changed.`);
  if (pkg.status === "CANCELLED") throw new InvalidStateError(`Package ${pkg.packageNumber} was cancelled.`);
  return { session, pkg };
}

export async function createPackage(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { idempotencyKey, sessionId, ...details } = parseInput(createPackageSchema, raw);
  if (!(await packingRepo(ctx).findSession(sessionId))) throw new NotFoundError("Packing session not found");

  return packingMutation(ctx, {
    scope: "packing.createPackage",
    idempotencyKey,
    request: { sessionId, ...details },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const session = await repo.lockSession(sessionId);
      if (!session) throw new NotFoundError("Packing session not found");
      if (session.status !== "OPEN") throw new InvalidStateError(`The packing session is ${session.status.toLowerCase()}; packages can no longer be added.`);
      // Numbered 1, 2, 3 ... per order, under the session lock (one open session per order, so no race;
      // the unique (orderId, packageNumber) index is the backstop).
      const packageNumber = await repo.nextPackageNumber(session.orderId);
      const pkg = await repo.createPackage({
        sessionId,
        orderId: session.orderId,
        packageNumber,
        packageType: details.packageType ?? null,
        weightG: details.weightG ?? null,
        lengthMm: details.lengthMm ?? null,
        widthMm: details.widthMm ?? null,
        heightMm: details.heightMm ?? null,
      });
      await repo.recordEvent({ sessionId, type: "PACKAGE_CREATED", packageId: pkg.id, detail: `Package ${packageNumber}` });
      return { sessionId, packageId: pkg.id };
    },
  });
}

/** Change type, weight (g) and dimensions (mm) of an OPEN package. Null clears a value. */
export async function updatePackage(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { idempotencyKey, packageId, ...details } = parseInput(updatePackageSchema, raw);
  const pkg0 = await packingRepo(ctx).findPackage(packageId);
  if (!pkg0) throw new NotFoundError("Package not found");

  return packingMutation(ctx, {
    scope: "packing.updatePackage",
    idempotencyKey,
    request: { packageId, ...details },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, pkg0.sessionId, packageId);
      const data = {
        packageType: details.packageType ?? null,
        weightG: details.weightG ?? null,
        lengthMm: details.lengthMm ?? null,
        widthMm: details.widthMm ?? null,
        heightMm: details.heightMm ?? null,
      };
      if ((await repo.updatePackageDetails(packageId, data)).count === 0) throw new ConflictError("The package changed while updating; please retry.");
      await repo.recordEvent({ sessionId: session.id, type: "PACKAGE_UPDATED", packageId, detail: `Package ${pkg.packageNumber}` });
      return { sessionId: session.id, packageId };
    },
  });
}

/** OPEN -> COMPLETED. The package must contain something; afterwards it is immutable. */
export async function completePackage(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { packageId, idempotencyKey } = parseInput(packageActionSchema, raw);
  const pkg0 = await packingRepo(ctx).findPackage(packageId);
  if (!pkg0) throw new NotFoundError("Package not found");

  return packingMutation(ctx, {
    scope: "packing.completePackage",
    idempotencyKey,
    request: { packageId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, pkg0.sessionId, packageId);
      const items = await repo.itemsOfPackage(packageId);
      if (items.length === 0) throw new InvalidStateError(`Package ${pkg.packageNumber} is empty. Add items, or cancel the package.`);
      if (items.some((i) => i.quantity <= 0)) throw new InvalidStateError("A package contains an invalid quantity.");
      if ((await repo.closePackage(packageId, "COMPLETED")) === 0) throw new ConflictError("The package changed while completing; please retry.");
      await repo.recordEvent({
        sessionId: session.id,
        type: "PACKAGE_COMPLETED",
        packageId,
        quantityAfter: items.reduce((n, i) => n + i.quantity, 0),
        detail: `Package ${pkg.packageNumber}`,
      });
      return { sessionId: session.id, packageId };
    },
  });
}

/** Cancel an OPEN package: its quantities become unpacked again. Package rows are kept as history. */
export async function cancelPackage(ctx: TenantContext, raw: unknown): Promise<PackingResultDto> {
  requirePermission(ctx, "packing.manage");
  const { packageId, idempotencyKey } = parseInput(packageActionSchema, raw);
  const pkg0 = await packingRepo(ctx).findPackage(packageId);
  if (!pkg0) throw new NotFoundError("Package not found");

  return packingMutation(ctx, {
    scope: "packing.cancelPackage",
    idempotencyKey,
    request: { packageId },
    work: async (tx) => {
      const repo = packingRepo(ctx, tx);
      const { session, pkg } = await lockOpenPackage(ctx, tx, pkg0.sessionId, packageId);
      const items = (await repo.itemsOfPackage(packageId)).sort((a, b) => (a.orderLineId < b.orderLineId ? -1 : 1));
      for (const item of items) {
        if (!(await repo.decreasePacked(item.orderLineId, item.quantity))) throw new ConflictError("Packed quantities are inconsistent; the change was aborted");
      }
      await repo.closePackage(packageId, "CANCELLED");
      await repo.recordEvent({ sessionId: session.id, type: "PACKAGE_CANCELLED", packageId, detail: `Package ${pkg.packageNumber}` });
      return { sessionId: session.id, packageId };
    },
  });
}

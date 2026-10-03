import { ConflictError, NotFoundError, ValidationError, parseInput } from "@/lib/errors";
import { requirePermission, type TenantContext } from "@/modules/tenancy";
import { withTransaction } from "@/server/db";
import { validateRackStructure } from "../domain/structure";
import { warehouseRepo } from "../repo/warehouseRepo";
import { saveLayoutSchema } from "../schemas";
import type { LayoutDto } from "../types";
import { reconcileStructure } from "./reconcileStructure";
import { getLayout } from "./warehouses";

/**
 * Replace the floor plan with the submitted state, atomically.
 *
 * - Optimistic concurrency: `version` must equal the stored layoutVersion (ConflictError otherwise).
 *   The version bump is the first statement, so concurrent saves serialize on the warehouse row.
 * - Items missing from the payload are deleted; new ids are created; existing ids are updated.
 * - Each rack's structure is validated against its physical dimensions and reconciled into
 *   levels, bays and positions (location codes are generated from the structured fields).
 */
export async function saveLayout(ctx: TenantContext, warehouseId: string, raw: unknown): Promise<LayoutDto> {
  requirePermission(ctx, "warehouse.design");
  const input = parseInput(saveLayoutSchema, raw);

  const codes = new Set<string>();
  for (const rack of input.racks) {
    if (codes.has(rack.code)) throw new ValidationError(`Duplicate rack code ${rack.code}`);
    codes.add(rack.code);
  }

  await withTransaction(
    async (tx) => {
      const repo = warehouseRepo(ctx, tx);

      const updated = await repo.bumpVersion(warehouseId, input.version, input.warehouse);
      if (updated === 0) {
        if (!(await repo.findById(warehouseId))) throw new NotFoundError("Warehouse not found");
        throw new ConflictError("The layout was changed by someone else. Reload and re-apply your changes.");
      }

      const palletTypes = new Map((await repo.palletTypes()).map((p) => [p.id, p]));
      const issues = input.racks.flatMap((rack) =>
        validateRackStructure(rack, { levels: rack.levels, bays: rack.bays }, { palletTypes }).map((i) => ({
          ...i,
          path: `racks[${rack.code}].${i.path}`,
        })),
      );
      if (issues.length) throw new ValidationError(`Invalid rack configuration: ${issues[0].message}`, issues);

      // ---- objects
      const existingObjects = await repo.objects(warehouseId);
      const keepObjectIds = new Set(input.objects.map((o) => o.id));
      const removeObjects = existingObjects.filter((o) => !keepObjectIds.has(o.id)).map((o) => o.id);
      if (removeObjects.length) await repo.deleteObjects(removeObjects);
      const existingObjectIds = new Set(existingObjects.map((o) => o.id));
      const newObjects = input.objects.filter((o) => !existingObjectIds.has(o.id));
      if (newObjects.length)
        await repo.createObjects(
          warehouseId,
          newObjects.map((o) => ({ ...o, label: o.label ?? null })),
        );
      for (const o of input.objects.filter((o) => existingObjectIds.has(o.id))) {
        const { id, ...data } = o;
        await repo.updateObject(id, { ...data, label: data.label ?? null });
      }

      // ---- racks (deletes first so a freed code can be reused in the same save)
      const existingRacks = await repo.racks(warehouseId);
      const keepRackIds = new Set(input.racks.map((r) => r.id));
      const removeRacks = existingRacks.filter((r) => !keepRackIds.has(r.id)).map((r) => r.id);
      if (removeRacks.length) {
      // Positions go through the guarded path first: a rack holding stock cannot be deleted.
      for (const rackId of removeRacks) {
        await repo.removePositions((await repo.positions(rackId)).map((p) => p.id));
      }
      await repo.deleteRacks(removeRacks);
    }
      const existingRackIds = new Set(existingRacks.map((r) => r.id));

      for (const rack of input.racks) {
        const { levels, bays, ...fields } = rack;
        if (existingRackIds.has(rack.id)) {
          const { id, ...data } = fields;
          await repo.updateRack(id, { ...data, name: data.name ?? null });
        } else {
          await repo.createRack(warehouseId, { ...fields, name: fields.name ?? null });
        }
        await reconcileStructure(repo, { id: rack.id, warehouseId, code: rack.code }, { levels, bays });
      }
    },
    { timeoutMs: 30_000 },
  ).catch((error) => {
    if ((error as { code?: unknown })?.code === "P2002") {
      throw new ConflictError(
        "A rack code, position code or id is already in use. Rack codes must be unique within the warehouse.",
      );
    }
    throw error;
  });

  return getLayout(ctx, warehouseId);
}

// Make a rack's stored levels, bays and positions match its structure spec.
// Existing rows are updated in place (matched by index) so their ids stay stable; rows that are
// no longer wanted are removed through repo.removePositions (Phase 3 will guard stock/history).
import type { WarehouseRepo } from "../repo/warehouseRepo";
import { formatLocationCode } from "../domain/locationCode";
import { bayOffsets, type RackStructureSpec } from "../domain/structure";

export async function reconcileStructure(
  repo: WarehouseRepo,
  rack: { id: string; warehouseId: string; code: string },
  spec: RackStructureSpec,
): Promise<void> {
  const [exLevels, exBays, exPositions] = await Promise.all([repo.levels(rack.id), repo.bays(rack.id), repo.positions(rack.id)]);

  const levelIndexById = new Map(exLevels.map((l) => [l.id, l.levelIndex]));
  const bayIndexById = new Map(exBays.map((b) => [b.id, b.bayIndex]));
  const levelByIndex = new Map(exLevels.map((l) => [l.levelIndex, l]));
  const bayByIndex = new Map(exBays.map((b) => [b.bayIndex, b]));

  // Desired positions, keyed "levelIndex:bayIndex:positionIndex".
  const wanted = new Set<string>();
  spec.levels.forEach((_, i) =>
    spec.bays.forEach((bay, j) => {
      for (let k = 1; k <= bay.positionCount; k++) wanted.add(`${i}:${j + 1}:${k}`);
    }),
  );
  const positionKey = (p: { levelId: string; bayId: string; positionIndex: number }) =>
    `${levelIndexById.get(p.levelId)}:${bayIndexById.get(p.bayId)}:${p.positionIndex}`;

  // 1. Remove positions that no longer exist in the structure, then surplus levels and bays.
  const obsolete = exPositions.filter((p) => !wanted.has(positionKey(p))).map((p) => p.id);
  if (obsolete.length) await repo.removePositions(obsolete);
  const surplusLevels = exLevels.filter((l) => l.levelIndex >= spec.levels.length).map((l) => l.id);
  if (surplusLevels.length) await repo.deleteLevels(surplusLevels);
  const surplusBays = exBays.filter((b) => b.bayIndex > spec.bays.length).map((b) => b.id);
  if (surplusBays.length) await repo.deleteBays(surplusBays);

  // 2. Upsert levels and bays, remembering their ids.
  const levelIds: string[] = [];
  for (const [i, lv] of spec.levels.entries()) {
    const data = { elevationMm: lv.elevationMm, clearanceMm: lv.clearanceMm, maxLoadG: lv.maxLoadG ?? null };
    const existing = levelByIndex.get(i);
    if (existing) {
      if (existing.elevationMm !== data.elevationMm || existing.clearanceMm !== data.clearanceMm || existing.maxLoadG !== data.maxLoadG) {
        await repo.updateLevel(existing.id, data);
      }
      levelIds.push(existing.id);
    } else {
      levelIds.push((await repo.createLevel(rack.id, { levelIndex: i, ...data })).id);
    }
  }

  const offsets = bayOffsets(spec.bays);
  const bayIds: string[] = [];
  for (const [j, bay] of spec.bays.entries()) {
    const data = {
      offsetMm: offsets[j],
      widthMm: bay.widthMm,
      positionCount: bay.positionCount,
      palletTypeId: bay.palletTypeId ?? null,
    };
    const existing = bayByIndex.get(j + 1);
    if (existing) {
      if (
        existing.offsetMm !== data.offsetMm ||
        existing.widthMm !== data.widthMm ||
        existing.positionCount !== data.positionCount ||
        existing.palletTypeId !== data.palletTypeId
      ) {
        await repo.updateBay(existing.id, data);
      }
      bayIds.push(existing.id);
    } else {
      bayIds.push((await repo.createBay(rack.id, { bayIndex: j + 1, ...data })).id);
    }
  }

  // 3. Create missing positions; refresh code/pallet type on surviving ones (e.g. after a rack rename).
  const surviving = new Map(exPositions.filter((p) => wanted.has(positionKey(p))).map((p) => [positionKey(p), p]));
  const toCreate: Parameters<WarehouseRepo["createPositions"]>[2] = [];
  for (const [i] of spec.levels.entries()) {
    for (const [j, bay] of spec.bays.entries()) {
      for (let k = 1; k <= bay.positionCount; k++) {
        const code = formatLocationCode({ rackCode: rack.code, levelIndex: i, bayIndex: j + 1, positionIndex: k });
        const palletTypeId = bay.palletTypeId ?? null;
        const existing = surviving.get(`${i}:${j + 1}:${k}`);
        if (!existing) {
          toCreate.push({ levelId: levelIds[i], bayId: bayIds[j], positionIndex: k, code, palletTypeId });
        } else if (existing.code !== code || existing.palletTypeId !== palletTypeId) {
          await repo.updatePosition(existing.id, { code, palletTypeId });
        }
      }
    }
  }
  if (toCreate.length) await repo.createPositions(rack.warehouseId, rack.id, toCreate);
}

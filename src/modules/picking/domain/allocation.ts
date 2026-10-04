// Allocation planning. Pure and deterministic: no I/O.
//
// Given what an order line still needs and the positions that hold AVAILABLE stock (already in
// stable physical order: rack, level, bay, position), take from the first positions first, never
// more than a position has available, and stop when the need is met. No optimization (no route
// planning, no pallet-first rules): the same inputs always give the same plan.

export interface AvailableAt {
  positionId: string;
  positionCode: string;
  warehouseId: string;
  available: number;
}

export interface PlannedPick {
  positionId: string;
  positionCode: string;
  warehouseId: string;
  quantity: number;
}

export function planAllocation(needed: number, candidates: readonly AvailableAt[]): PlannedPick[] {
  const plan: PlannedPick[] = [];
  let remaining = needed;
  for (const c of candidates) {
    if (remaining <= 0) break;
    if (c.available <= 0) continue;
    const take = Math.min(remaining, c.available);
    plan.push({ positionId: c.positionId, positionCode: c.positionCode, warehouseId: c.warehouseId, quantity: take });
    remaining -= take;
  }
  return plan;
}

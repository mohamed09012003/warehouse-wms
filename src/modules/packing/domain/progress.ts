// Packing rules that need no I/O. Quantities are integers.
//
// Picked-vs-packed (the core invariant): for every order line, packed <= picked <= allocated <= requested.
//
// A session may be completed when EVERYTHING picked so far is packed (packed == picked on every line
// and something was picked). The ORDER is PACKED only when, in addition, every requested unit has been
// picked and packed (packed == requested on every line). A partially picked order therefore stays
// PICKING after its session completes, and gets another session when more is picked.

export interface PackLine {
  requestedQty: number;
  pickedQty: number;
  packedQty: number;
}

export interface PackTotals {
  requested: number;
  picked: number;
  packed: number;
  /** picked but not yet in a package */
  remaining: number;
}

export function totals(lines: readonly PackLine[]): PackTotals {
  const sum = (pick: (l: PackLine) => number) => lines.reduce((n, l) => n + pick(l), 0);
  const picked = sum((l) => l.pickedQty);
  const packed = sum((l) => l.packedQty);
  return { requested: sum((l) => l.requestedQty), picked, packed, remaining: picked - packed };
}

/** Quantity of a line that is picked but not yet in any package. */
export function remainingToPack(line: PackLine): number {
  return line.pickedQty - line.packedQty;
}

/** Everything picked so far is packed (and something was picked): the session may be completed. */
export function allPickedIsPacked(lines: readonly PackLine[]): boolean {
  return lines.some((l) => l.pickedQty > 0) && lines.every((l) => l.packedQty === l.pickedQty);
}

/** Every requested unit is picked AND packed: the order may become PACKED. */
export function orderFullyPacked(lines: readonly PackLine[]): boolean {
  return lines.length > 0 && lines.every((l) => l.packedQty === l.requestedQty);
}

export const PACKABLE_ORDER_STATUSES = ["PICKING", "PICKED"] as const;

/** Why packing cannot start for an order (null = it can). */
export function startBlocker(status: string, lines: readonly PackLine[]): string | null {
  if (status === "CANCELLED") return "A cancelled order cannot be packed.";
  if (status === "PACKED") return "This order is already packed.";
  if (status === "PACKING") return "This order already has a packing session in progress.";
  if (!(PACKABLE_ORDER_STATUSES as readonly string[]).includes(status)) {
    return `Only an order with picked quantity can be packed (this order is ${status}).`;
  }
  const t = totals(lines);
  if (t.picked === 0) return "Nothing has been picked for this order yet.";
  if (t.remaining === 0) return "Everything picked so far has already been packed. Pick more before packing again.";
  return null;
}

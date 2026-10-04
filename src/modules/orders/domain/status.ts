// Order lifecycle. Pure functions (no I/O).
//
//   DRAFT ──ready──▶ READY ──allocate──▶ PARTIALLY_ALLOCATED ─┐
//     │                │  ╲                    │ allocate again│ (more stock arrived)
//     │                │   ╲──allocate──▶ ALLOCATED ◀──────────┘
//     │                │                      │
//     │                │         first pick   ▼
//     │                │                  PICKING ──all lines fully picked──▶ PICKED
//     └──cancel────────┴──────────cancel (any non-final status)──────────────▶ CANCELLED
//
// Releasing an allocation (or cancelling a wave) returns the order to READY / PARTIALLY_ALLOCATED /
// ALLOCATED according to what is still reserved. PICKED and CANCELLED are final.
export const ORDER_STATUSES = ["DRAFT", "READY", "PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING", "PICKED", "CANCELLED"] as const;
export type OrderStatusName = (typeof ORDER_STATUSES)[number];

export interface LineQuantities {
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
}

export type AllocationState = "NONE" | "PARTIAL" | "FULL";

/** Allocation state shown to users: never "FULL" unless EVERY line is fully allocated. */
export function allocationState(lines: readonly LineQuantities[]): AllocationState {
  const anyAllocated = lines.some((l) => l.allocatedQty > 0);
  if (!anyAllocated) return "NONE";
  return lines.every((l) => l.allocatedQty === l.requestedQty) ? "FULL" : "PARTIAL";
}

/**
 * The status an order in the allocation/picking phase should have, derived from its lines:
 * every line fully picked -> PICKED; anything picked -> PICKING; everything allocated -> ALLOCATED;
 * something allocated -> PARTIALLY_ALLOCATED; nothing -> READY.
 */
export function deriveFulfilmentStatus(lines: readonly LineQuantities[]): Exclude<OrderStatusName, "DRAFT" | "CANCELLED"> {
  if (lines.length > 0 && lines.every((l) => l.pickedQty === l.requestedQty)) return "PICKED";
  if (lines.some((l) => l.pickedQty > 0)) return "PICKING";
  const state = allocationState(lines);
  if (state === "FULL") return "ALLOCATED";
  if (state === "PARTIAL") return "PARTIALLY_ALLOCATED";
  return "READY";
}

const TRANSITIONS: Record<OrderStatusName, readonly OrderStatusName[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["PARTIALLY_ALLOCATED", "ALLOCATED", "CANCELLED"],
  PARTIALLY_ALLOCATED: ["PARTIALLY_ALLOCATED", "ALLOCATED", "READY", "PICKING", "CANCELLED"],
  ALLOCATED: ["READY", "PARTIALLY_ALLOCATED", "PICKING", "CANCELLED"],
  PICKING: ["PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING", "PICKED", "CANCELLED"],
  PICKED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatusName, to: OrderStatusName): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses in which stock may be allocated (including topping up while picking has started). */
export const ALLOCATABLE_STATUSES: readonly OrderStatusName[] = ["READY", "PARTIALLY_ALLOCATED", "PICKING"];
/** Statuses an order can be cancelled from. */
export const CANCELLABLE_STATUSES: readonly OrderStatusName[] = ["DRAFT", "READY", "PARTIALLY_ALLOCATED", "ALLOCATED", "PICKING"];
/** Statuses whose allocation can be released before any picking has happened. */
export const RELEASABLE_STATUSES: readonly OrderStatusName[] = ["PARTIALLY_ALLOCATED", "ALLOCATED"];

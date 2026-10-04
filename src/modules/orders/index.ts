// Public API of the orders module: order entry, lifecycle up to READY, and reads.
// Allocation, picking and the fulfilment statuses live in the picking module, which uses the pure
// lifecycle helpers exported here.
export { listOrders, getOrder, createOrder, markOrderReady } from "./service/orders";
export type { OrderSummaryDto, OrderDetailDto, OrderLineDto } from "./types";
export {
  ORDER_STATUSES,
  ALLOCATABLE_STATUSES,
  CANCELLABLE_STATUSES,
  RELEASABLE_STATUSES,
  allocationState,
  deriveFulfilmentStatus,
  canTransition,
} from "./domain/status";
export type { AllocationState, OrderStatusName, LineQuantities } from "./domain/status";

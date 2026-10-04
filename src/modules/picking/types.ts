// Plain shapes returned by the picking services and API. Type-only: safe for client components.
import type { OrderStatusName, AllocationState } from "@/modules/orders";

export type WaveStatusName = "DRAFT" | "RELEASED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type PickTaskStatusName = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface PickTaskDto {
  id: string;
  status: PickTaskStatusName;
  waveId: string | null;
  waveNumber: number | null;
  waveStatus: WaveStatusName | null;
  orderId: string;
  orderNumber: string;
  orderStatus?: OrderStatusName;
  orderLineId: string;
  productId: string;
  sku: string;
  productName: string;
  positionId: string;
  positionCode: string;
  quantity: number;
  pickedQty: number;
  remainingQty: number;
}

export interface WaveSummaryDto {
  id: string;
  number: number;
  status: WaveStatusName;
  note: string | null;
  taskCount: number;
  completedTaskCount: number;
  orderCount: number;
  totalQuantity: number;
  pickedQuantity: number;
  /** picked / planned quantity of non-cancelled tasks, 0-100. */
  progressPercent: number;
  createdAt: string;
}

export interface WaveDetailDto extends WaveSummaryDto {
  tasks: PickTaskDto[];
}

export interface EligibleOrderDto {
  id: string;
  orderNumber: string;
  status: OrderStatusName;
  pendingTaskCount: number;
  pendingQuantity: number;
}

export interface AllocationResultDto {
  orderId: string;
  replayed: boolean;
  status: OrderStatusName;
  allocationState: AllocationState;
  requestedTotal: number;
  allocatedTotal: number;
  /** Reserved by THIS request. */
  allocatedNow: number;
  tasksCreated: number;
}

export interface OrderActionResultDto {
  orderId: string;
  replayed: boolean;
  status: OrderStatusName;
  tasksCancelled: number;
}

export interface PickResultDto {
  operationId: string;
  /** true when an Idempotency-Key matched an earlier identical confirmation (nothing was consumed again). */
  replayed: boolean;
  task: PickTaskDto;
  orderStatus: OrderStatusName;
  waveStatus: WaveStatusName | null;
  /** Stock after this pick at the source position (absent on a replay). */
  onHandAfter?: number;
  reservedAfter?: number;
}

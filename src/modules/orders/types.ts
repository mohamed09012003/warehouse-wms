// Plain shapes returned by the orders services and API. Type-only: safe for client components.
import type { AllocationState, OrderStatusName } from "./domain/status";

export interface OrderSummaryDto {
  id: string;
  orderNumber: string;
  status: OrderStatusName;
  externalRef: string | null;
  lineCount: number;
  requestedTotal: number;
  allocatedTotal: number;
  pickedTotal: number;
  /** NONE, PARTIAL or FULL. FULL only when every line is fully allocated. */
  allocationState: AllocationState;
  createdAt: string;
}

export interface OrderLineDto {
  id: string;
  lineNo: number;
  productId: string;
  sku: string;
  productName: string;
  requestedQty: number;
  allocatedQty: number;
  pickedQty: number;
  /** requested - allocated: still waiting for stock. */
  unallocatedQty: number;
}

export interface OrderDetailDto extends OrderSummaryDto {
  note: string | null;
  lines: OrderLineDto[];
}

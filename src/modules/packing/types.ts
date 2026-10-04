// Plain shapes returned by the packing services and API. Type-only: safe for client components.
import type { OrderStatusName } from "@/modules/orders";

export type PackingSessionStatusName = "OPEN" | "COMPLETED" | "CANCELLED";
export type PackageStatusName = "OPEN" | "COMPLETED" | "CANCELLED";

export interface PackableOrderDto {
  orderId: string;
  orderNumber: string;
  status: OrderStatusName;
  requestedTotal: number;
  pickedTotal: number;
  packedTotal: number;
  /** picked but not yet packed */
  remainingTotal: number;
  /** packages that are open or completed (cancelled ones are not counted) */
  packageCount: number;
  openSessionId: string | null;
  /** The most recent packing session (any status), for review. */
  lastSessionId: string | null;
  /** Whether a new packing session could be started right now. */
  canStart: boolean;
  /** Why not, when canStart is false (e.g. everything picked so far is already packed). */
  blockedReason: string | null;
}

export interface PackingLineDto {
  orderLineId: string;
  productId: string;
  sku: string;
  productName: string;
  requestedQty: number;
  pickedQty: number;
  packedQty: number;
  /** picked - packed: what may still be put into packages */
  remainingQty: number;
}

export interface PackageItemDto {
  id: string;
  orderLineId: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
}

export interface PackageDto {
  id: string;
  packageNumber: number;
  status: PackageStatusName;
  packageType: string | null;
  weightG: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  totalQuantity: number;
  items: PackageItemDto[];
  completedAt: string | null;
}

export interface PackingSessionDto {
  id: string;
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatusName;
  status: PackingSessionStatusName;
  startedAt: string;
  completedAt: string | null;
  lines: PackingLineDto[];
  packages: PackageDto[];
  requestedTotal: number;
  pickedTotal: number;
  packedTotal: number;
  remainingTotal: number;
  openPackageCount: number;
  /** All picked quantity is packed, no package is open and at least one is completed. */
  canComplete: boolean;
}

/** Result of a mutation: the session after the change; `replayed` when an Idempotency-Key matched an earlier identical request. */
export interface PackingResultDto {
  replayed: boolean;
  session: PackingSessionDto;
  /** The package the request was about, when there is one. */
  packageId?: string;
}

// Plain shapes returned by the inventory services and API. Type-only: safe for client components.

export type InventoryMovementTypeName = "RECEIVE" | "MOVE" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT" | "RESERVE" | "RELEASE";

export interface StockRowDto {
  balanceId: string;
  productId: string;
  sku: string;
  productName: string;
  warehouseId: string;
  warehouseCode: string;
  positionId: string;
  positionCode: string;
  onHand: number;
  reserved: number;
  /** onHand - reserved, computed on read; never stored. */
  available: number;
}

export interface MovementDto {
  id: string;
  operationId: string;
  type: InventoryMovementTypeName;
  productId: string;
  sku?: string;
  positionId: string;
  positionCode: string;
  counterpartPositionCode: string | null;
  qtyDelta: number;
  reservedDelta: number;
  onHandAfter: number;
  reservedAfter: number;
  createdAt: string;
  reason?: string | null;
  actorName?: string | null;
}

export interface OperationResultDto {
  operationId: string;
  /** true when an Idempotency-Key matched an earlier identical request (nothing was applied again). */
  replayed: boolean;
  movements: MovementDto[];
  reservationId?: string;
}

export interface ReservationDto {
  id: string;
  status: "ACTIVE" | "RELEASED";
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdAt: string;
  releasedAt: string | null;
  lines: { productId: string; sku: string; positionId: string; positionCode: string; quantity: number }[];
}

// Public API of the inventory module. Balances are changed ONLY through these operations.
export { receiveStock, moveStock, adjustStock, createReservation, releaseReservation } from "./service/operations";
export { listStock, listMovements, listReservations, getReservation } from "./service/queries";
export type { StockRowDto, MovementDto, OperationResultDto, ReservationDto, InventoryMovementTypeName } from "./types";

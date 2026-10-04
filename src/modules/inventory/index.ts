// Public API of the inventory module. Balances are changed ONLY through these operations.
export { receiveStock, moveStock, adjustStock, createReservation, releaseReservation } from "./service/operations";
export { listStock, listMovements, listReservations, getReservation } from "./service/queries";
export type { StockRowDto, MovementDto, OperationResultDto, ReservationDto, InventoryMovementTypeName } from "./types";
// Internal composition API for other modules (picking). No permission check, no HTTP route.
export { runStockOperation } from "./service/stockTx";
export type { StockTx, AvailablePosition, ReservedPosition } from "./service/stockTx";

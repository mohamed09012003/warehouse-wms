// Small, shared error taxonomy. Domain code throws these; only the API/UI boundary
// translates them into HTTP responses or user-facing messages.
import type { ZodError } from "zod";

export type ErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_STOCK"
  | "POSITION_IN_USE"
  | "POSITION_OCCUPIED"
  | "RESERVATION_UNAVAILABLE"
  | "INVALID_STATE"
  | "WRONG_LOCATION"
  | "WRONG_PRODUCT"
  | "TASK_NOT_PICKABLE"
  | "PICK_QUANTITY_EXCEEDED"
  | "DATABASE_ERROR"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super("AUTHENTICATION_REQUIRED", 401, message);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "You do not have access to this resource") {
    super("FORBIDDEN", 403, message);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid input", details?: unknown) {
    super("VALIDATION_FAILED", 400, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", 404, message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super("CONFLICT", 409, message);
  }
}

/** Not enough AVAILABLE (onHand - reserved) stock for the requested operation. */
export class InsufficientStockError extends AppError {
  constructor(message = "Not enough available stock", details?: unknown) {
    super("INSUFFICIENT_STOCK", 409, message, details);
  }
}

/** A layout change would delete a position that holds stock or reservations. */
export class PositionInUseError extends AppError {
  constructor(message = "Position holds stock", details?: unknown) {
    super("POSITION_IN_USE", 409, message, details);
  }
}

/** The target position already holds a DIFFERENT product (a position holds one product at a time). */
export class PositionOccupiedError extends AppError {
  constructor(message = "This position is already occupied by a different product", details?: unknown) {
    super("POSITION_OCCUPIED", 409, message, details);
  }
}

/** Name of the partial unique index that enforces one product per position (see the migration). */
export const SINGLE_PRODUCT_POSITION_INDEX = "InventoryBalance_one_product_per_position_idx";

function driverCause(error: unknown) {
  return (error as { meta?: { driverAdapterError?: { cause?: Record<string, unknown> } } } | null)?.meta?.driverAdapterError?.cause;
}

/** True when a raw-query database error mentions the given constraint/index name. */
export function mentionsConstraint(error: unknown, name: string): boolean {
  const cause = driverCause(error);
  return [cause?.constraint, cause?.originalMessage, cause?.message].some((v) => typeof v === "string" && v.includes(name));
}

/** The reservation backing a pick no longer holds the stock (released, consumed or inconsistent). */
export class ReservationUnavailableError extends AppError {
  constructor(message = "The reserved stock is no longer available", details?: unknown) {
    super("RESERVATION_UNAVAILABLE", 409, message, details);
  }
}

/** The requested action is not allowed in the entity's current status (order, wave, task). */
export class InvalidStateError extends AppError {
  constructor(message = "This action is not allowed in the current status", details?: unknown) {
    super("INVALID_STATE", 409, message, details);
  }
}

/** The scanned/typed location is not the task's source position. */
export class WrongLocationError extends AppError {
  constructor(message = "Wrong location", details?: unknown) {
    super("WRONG_LOCATION", 422, message, details);
  }
}

/** The scanned/typed product is not the task's product. */
export class WrongProductError extends AppError {
  constructor(message = "Wrong product", details?: unknown) {
    super("WRONG_PRODUCT", 422, message, details);
  }
}

/** The pick task cannot be picked now (completed, cancelled, wave not started, ...). */
export class TaskNotPickableError extends AppError {
  constructor(message = "This task cannot be picked", details?: unknown) {
    super("TASK_NOT_PICKABLE", 409, message, details);
  }
}

/** The quantity exceeds what is left on the task or the order line. */
export class PickQuantityError extends AppError {
  constructor(message = "Quantity exceeds what remains to pick", details?: unknown) {
    super("PICK_QUANTITY_EXCEEDED", 422, message, details);
  }
}

export class DatabaseError extends AppError {
  constructor(message = "A database error occurred") {
    super("DATABASE_ERROR", 500, message);
  }
}

/** Parse untrusted input with a Zod schema, throwing ValidationError on failure. */
export function parseInput<T>(
  schema: { safeParse(data: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  data: unknown,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError("Invalid input", result.error.issues);
  }
  return result.data;
}

/** SQLSTATE of a database error raised through a raw query (Prisma P2010), or undefined. */
export function sqlStateOf(error: unknown): string | undefined {
  const meta = (error as { meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } } } | null)?.meta;
  const state = meta?.driverAdapterError?.cause?.originalCode ?? meta?.driverAdapterError?.cause?.code ?? meta?.code;
  return typeof state === "string" ? state : undefined;
}

/**
 * Map a Prisma/driver error to an AppError. Never leaks SQL, table or credential details.
 * Returns the input unchanged when it is already an AppError.
 */
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002") return new ConflictError("A record with these values already exists");
  if (code === "P2003") return new ConflictError("The operation conflicts with related records");
  if (code === "P2025") return new NotFoundError();
  // Raw queries report database errors as P2010 with the SQLSTATE in meta.code; 23514 = CHECK violation.
  const sqlState = code === "P2010" ? sqlStateOf(error) : undefined;
  if (sqlState === "23514") return new ValidationError("A value is outside the allowed range");
  if (sqlState === "23503") return new ConflictError("The operation conflicts with related records");
  // A concurrent request placed a different product on the same position first.
  if (sqlState === "23505" && mentionsConstraint(error, SINGLE_PRODUCT_POSITION_INDEX)) {
    return new PositionOccupiedError("This position is already occupied by a different product. Choose another position.");
  }
  if (typeof code === "string" && /^P\d{4}$/.test(code)) return new DatabaseError();
  return new AppError("INTERNAL_ERROR", 500, "Internal server error");
}

/** For route handlers: convert any thrown value into a JSON Response. */
export function toErrorResponse(error: unknown): Response {
  const appError = normalizeError(error);
  if (appError.status >= 500) console.error(appError.code, error instanceof Error ? error.message : "");
  return Response.json(
    { error: { code: appError.code, message: appError.message, details: appError.details } },
    { status: appError.status },
  );
}

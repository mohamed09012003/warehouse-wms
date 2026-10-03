// Small, shared error taxonomy. Domain code throws these; only the API/UI boundary
// translates them into HTTP responses or user-facing messages.
import type { ZodError } from "zod";

export type ErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
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

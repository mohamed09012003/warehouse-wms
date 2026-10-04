// Error classification for inbound processing. Everything that leaves this file is a code plus a short,
// redacted summary: raw error messages, SQL and payload data never become stored text.
import { ZodError } from "zod";
import { AppError } from "@/lib/errors";
import { redactText } from "@/lib/redact";

/** A handler deliberately rejects an event for good (bad data, unknown reference, rule violation). */
export class InboundRejectError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "InboundRejectError";
  }
}

/** Thrown inside the processing transaction when the lease was lost, so the whole attempt rolls back. */
export class LeaseLostError extends Error {
  constructor() {
    super("The processing lease was lost");
    this.name = "LeaseLostError";
  }
}

export type InboundFailure =
  /** Permanent: the event can never succeed as sent. Status REJECTED, no retry. */
  | { kind: "rejected"; code: string; summary: string }
  /** Transient: worth retrying (database contention, a concurrent change, an unexpected fault). */
  | { kind: "transient"; code: string; summary: string }
  | { kind: "lease_lost" };

export function summarizeZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid payload";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return redactText(`${path}${issue.message}`, 200);
}

export function classifyInboundError(error: unknown): InboundFailure {
  if (error instanceof LeaseLostError) return { kind: "lease_lost" };
  if (error instanceof InboundRejectError) return { kind: "rejected", code: error.code, summary: redactText(error.message, 200) };
  if (error instanceof ZodError) return { kind: "rejected", code: "INVALID_PAYLOAD", summary: summarizeZodError(error) };
  if (error instanceof AppError) {
    // CONFLICT means "something changed concurrently, retry"; every other 4xx is a permanent business answer.
    if (error.status >= 500 || error.code === "CONFLICT") {
      return { kind: "transient", code: error.code, summary: redactText(error.message, 200) };
    }
    return { kind: "rejected", code: error.code, summary: redactText(error.message, 200) };
  }
  const prismaCode = (error as { code?: unknown } | null)?.code;
  if (typeof prismaCode === "string" && /^P\d{4}$/.test(prismaCode)) {
    return { kind: "transient", code: "DATABASE_ERROR", summary: "A database error occurred while processing the event" };
  }
  return { kind: "transient", code: "INTERNAL_ERROR", summary: "Unexpected error while processing the event" };
}

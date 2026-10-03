import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma } from "./client";

export type Tx = Prisma.TransactionClient;
/** What repositories accept: the root client or a transaction client. */
export type DbClient = PrismaClient | Tx;

// 40001 serialization_failure, 40P01 deadlock_detected (Prisma reports write conflicts as P2034).
function isRetryable(error: unknown): boolean {
  const e = error as { code?: unknown } | null;
  return e?.code === "P2034" || e?.code === "40001" || e?.code === "40P01";
}

/**
 * Run `fn` in a PostgreSQL transaction, retrying on serialization failures and deadlocks.
 * `fn` must be safe to re-run: do all work through `tx`, no external side effects.
 * Phase 9 (RLS) will add `SET LOCAL app.organization_id` here.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { timeout: options.timeoutMs ?? 5000 });
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) throw error;
      await new Promise((r) => setTimeout(r, 25 * attempt + Math.random() * 25));
    }
  }
}

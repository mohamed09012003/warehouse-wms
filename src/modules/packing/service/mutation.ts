// Runs a packing mutation in ONE transaction with optional idempotency.
//
// With an Idempotency-Key: the key's record is inserted first, inside the same transaction as the
// work. A repeated request (same scope + key + same request) therefore finds the record and returns
// the CURRENT state without doing the work again; the same key with a different request is a
// conflict; two identical requests racing each other are serialized by the unique index (the loser
// waits, then replays). If the work fails, the record rolls back with it, so the key can be reused.
import { createHash } from "node:crypto";
import { ConflictError, normalizeError } from "@/lib/errors";
import type { TenantContext } from "@/modules/tenancy";
import { withTransaction, type Tx } from "@/server/db";
import { packingRepo } from "../repo/packingRepo";
import type { PackingResultDto } from "../types";
import { loadSession } from "./queries";

export interface MutationOutcome {
  sessionId: string;
  packageId?: string;
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

export async function packingMutation(
  ctx: TenantContext,
  opts: { scope: string; idempotencyKey?: string; request: unknown; work: (tx: Tx) => Promise<MutationOutcome> },
): Promise<PackingResultDto> {
  const { scope, idempotencyKey } = opts;
  const requestHash = createHash("sha256").update(JSON.stringify([scope, opts.request])).digest("hex");

  const replay = async (): Promise<PackingResultDto | null> => {
    if (!idempotencyKey) return null;
    const record = await packingRepo(ctx).findIdempotency(scope, idempotencyKey);
    if (!record) return null;
    if (record.requestHash !== requestHash) throw new ConflictError("This idempotency key was already used for a different request");
    if (!record.resourceId) return null; // the first request is still in flight; fall through and wait on the unique index
    const repo = packingRepo(ctx);
    const packageId = record.resourceType === "PACKAGE" ? record.resourceId : undefined;
    const sessionId = packageId ? (await repo.findPackage(packageId))?.sessionId : record.resourceId;
    if (!sessionId) return null;
    return { replayed: true, session: await loadSession(ctx, sessionId), packageId };
  };

  const earlier = await replay();
  if (earlier) return earlier;

  try {
    const outcome = await withTransaction(async (tx) => {
      const repo = packingRepo(ctx, tx);
      const record = idempotencyKey ? await repo.insertIdempotency(scope, idempotencyKey, requestHash) : null;
      const out = await opts.work(tx);
      if (record) await repo.setIdempotencyResource(record.id, out.packageId ? "PACKAGE" : "SESSION", out.packageId ?? out.sessionId);
      return out;
    });
    return { replayed: false, session: await loadSession(ctx, outcome.sessionId), packageId: outcome.packageId };
  } catch (error) {
    // Another identical request won the race for the key: answer from its record.
    if (idempotencyKey && isUniqueViolation(error)) {
      const raced = await replay();
      if (raced) return raced;
    }
    const known = normalizeError(error);
    if (known.code !== "INTERNAL_ERROR") throw known;
    throw error;
  }
}

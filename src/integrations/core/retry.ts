// Pure retry policy shared by inbound processing and outbound delivery. No I/O.

/** Delay after the n-th failed attempt (index n-1); later attempts reuse the last value. */
export const BACKOFF_SCHEDULE_MS = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000] as const;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const MIN_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 12;
/** A claimed row is processed within this window; afterwards the reaper may reclaim it. */
export const LEASE_SECONDS = 60;
/** A remote Retry-After is honoured but never longer than this. */
export const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;
export const MIN_RETRY_AFTER_MS = 1_000;

/** Bounded per-integration override (config.maxAttempts), else the default. */
export function effectiveMaxAttempts(configured: unknown): number {
  const n = typeof configured === "number" && Number.isInteger(configured) ? configured : DEFAULT_MAX_ATTEMPTS;
  return Math.min(MAX_MAX_ATTEMPTS, Math.max(MIN_MAX_ATTEMPTS, n));
}

/** Backoff after `attempts` attempts have been made (>= 1). */
export function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[index];
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into a capped delay, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  let ms: number;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    ms = at - now.getTime();
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

export type FailureDecision = { status: "FAILED"; nextAttemptAt: Date } | { status: "DEAD" };

/** After attempt number `attempts` failed transiently: retry later, or give up (DEAD) once the maximum is reached. */
export function decideAfterTransientFailure(attempts: number, maxAttempts: number, now: Date, retryAfterMs?: number): FailureDecision {
  if (attempts >= maxAttempts) return { status: "DEAD" };
  return { status: "FAILED", nextAttemptAt: new Date(now.getTime() + (retryAfterMs ?? backoffMs(attempts))) };
}

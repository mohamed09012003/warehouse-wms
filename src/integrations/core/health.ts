// Integration health from the number of consecutive failures. Deliberately simple.
//
//   0-2 consecutive failures  HEALTHY
//   3-9                       DEGRADED
//   10+                       FAILING   (and outbound delivery is paused automatically)
//
// The counters are kept PER DIRECTION and are completely independent: inbound outcomes only move the inbound
// counter, outbound outcomes only the outbound one. Any success in a direction resets that direction's counter.
// Counted failures: transient processing failures, dead events/deliveries and lease expiries in that direction,
// plus failed connection tests (outbound). REJECTED inbound events (bad data) are the sender's problem and do not count.
// Only the OUTBOUND counter drives the circuit breaker (outbound delivery pauses at 10); a paused integration keeps its
// PENDING deliveries and an admin resumes it with Enable. Inbound health never pauses anything.
export const DEGRADED_AFTER = 3;
export const FAILING_AFTER = 10;
export const PAUSE_OUTBOUND_AFTER = 10;

export type HealthStatusName = "HEALTHY" | "DEGRADED" | "FAILING";

export function healthFor(consecutiveFailures: number): HealthStatusName {
  if (consecutiveFailures >= FAILING_AFTER) return "FAILING";
  if (consecutiveFailures >= DEGRADED_AFTER) return "DEGRADED";
  return "HEALTHY";
}

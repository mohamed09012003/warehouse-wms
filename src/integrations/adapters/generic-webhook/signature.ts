// Webhook signing, shared by the inbound verifier and the outbound sender.
//
//   X-WMS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
//
// Verification uses a constant-time comparison, rejects timestamps outside +-5 minutes, and accepts
// several `v1` values / several candidate secrets (rotation grace period).
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-WMS-Signature";
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function signatureHeaderValue(secret: string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${computeSignature(secret, timestamp, rawBody)}`;
}

export function parseSignatureHeader(value: string | null): { timestamp: number; signatures: string[] } | null {
  if (!value || value.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) return null;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();
    if (key === "t") {
      if (!/^\d{1,12}$/.test(val)) return null;
      timestamp = Number(val);
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/i.test(val)) return null;
      signatures.push(val.toLowerCase());
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export type SignatureCheck = "ok" | "invalid" | "stale";

/** Check a signature header against the raw body with any of the candidate secrets. */
export function verifySignature(input: { header: string | null; rawBody: string; secrets: readonly string[]; now: Date }): SignatureCheck {
  const parsed = parseSignatureHeader(input.header);
  if (!parsed || input.secrets.length === 0) return "invalid";
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  let matched = false;
  // Compare against every candidate and every supplied signature without short-circuiting.
  for (const secret of input.secrets) {
    const expected = Buffer.from(computeSignature(secret, parsed.timestamp, input.rawBody), "hex");
    for (const sig of parsed.signatures) {
      const given = Buffer.from(sig, "hex");
      if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
    }
  }
  if (!matched) return "invalid";
  return Math.abs(nowSeconds - parsed.timestamp) > TIMESTAMP_TOLERANCE_SECONDS ? "stale" : "ok";
}

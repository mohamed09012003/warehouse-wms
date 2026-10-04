// FAKE ERP (development tool): pure helpers. This file deliberately does NOT import anything from the WMS:
// the fake ERP behaves like an external system and re-implements the published Phase 6 webhook contract
// (docs/integrations.md). tests/fakeErp.test.ts checks it against the real WMS implementation.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-wms-signature";
export const TOLERANCE_SECONDS = 300;

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`: the same scheme in both directions. */
export function signBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export type Verification = "VALID" | "INVALID_SIGNATURE" | "STALE_TIMESTAMP" | "MISSING_SIGNATURE" | "NO_SECRET_CONFIGURED";

export function verifySignature(secret: string | null, header: string | null, body: string, now = new Date()): Verification {
  if (!secret) return "NO_SECRET_CONFIGURED";
  if (!header) return "MISSING_SIGNATURE";
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) return "INVALID_SIGNATURE";
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return "INVALID_SIGNATURE";
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  let matched = false;
  for (const sig of signatures) {
    const given = Buffer.from(sig, "hex");
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  if (!matched) return "INVALID_SIGNATURE";
  return Math.abs(Math.floor(now.getTime() / 1000) - timestamp) > TOLERANCE_SECONDS ? "STALE_TIMESTAMP" : "VALID";
}

// ---- redaction ---------------------------------------------------------------------------------------

const SECRET_KEY = /(secret|token|passw(or)?d|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|bearer|signature|cookie)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Deep copy with secret-looking keys and long token-like strings masked. Used for everything shown in the UI. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  }
  if (typeof value === "string") {
    if (UUID.test(value)) return value;
    return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]");
  }
  return value;
}

export function maskSecret(secret: string | null | undefined): string {
  return secret ? "set (hidden)" : "not set";
}

export const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

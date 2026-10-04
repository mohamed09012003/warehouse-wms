// Pure logic of the integration layer: retry policy, health, grants, address policy, signatures,
// keyring parsing, redaction and configuration validation. No database.
import { describe, expect, it } from "vitest";
import { parseKeyring } from "@/lib/keyring";
import { findSecretLookingKeys, redactText } from "@/lib/redact";
import { PERMISSIONS } from "@/modules/tenancy";
import { genericWebhookConfigSchema, targetUrlProblem } from "../adapters/generic-webhook/config";
import { computeSignature, parseSignatureHeader, signatureHeaderValue, verifySignature } from "../adapters/generic-webhook/signature";
import { ALLOWED_GRANTS, integrationPermissions } from "../core/grants";
import { DEGRADED_AFTER, FAILING_AFTER, healthFor } from "../core/health";
import { BACKOFF_SCHEDULE_MS, backoffMs, decideAfterTransientFailure, DEFAULT_MAX_ATTEMPTS, effectiveMaxAttempts, parseRetryAfter } from "../core/retry";
import { isForbiddenAddress } from "../http/ipPolicy";

describe("retry policy", () => {
  it("backs off 30s, 2m, 10m, 30m, 2h, 6h, 12h and then stays at 12h", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoffMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000, 43_200_000, 43_200_000]);
    expect(BACKOFF_SCHEDULE_MS).toHaveLength(7);
  });

  it("defaults to 8 attempts and bounds the per-integration override to 1-12", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
    expect(effectiveMaxAttempts(undefined)).toBe(8);
    expect(effectiveMaxAttempts("x")).toBe(8);
    expect(effectiveMaxAttempts(3)).toBe(3);
    expect(effectiveMaxAttempts(0)).toBe(1);
    expect(effectiveMaxAttempts(99)).toBe(12);
    expect(effectiveMaxAttempts(2.5)).toBe(8);
  });

  it("schedules a retry until the maximum is reached, then gives up (DEAD)", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(decideAfterTransientFailure(1, 8, now)).toEqual({ status: "FAILED", nextAttemptAt: new Date(now.getTime() + 30_000) });
    expect(decideAfterTransientFailure(7, 8, now)).toMatchObject({ status: "FAILED" });
    expect(decideAfterTransientFailure(8, 8, now)).toEqual({ status: "DEAD" });
    expect(decideAfterTransientFailure(1, 1, now)).toEqual({ status: "DEAD" });
  });

  it("honours Retry-After but caps it at one hour and floors it at one second", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("0", now)).toBe(1_000);
    expect(parseRetryAfter("999999", now)).toBe(3_600_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:10:00 GMT", now)).toBe(600_000);
    expect(parseRetryAfter("Thu, 01 Jan 2026 09:00:00 GMT", now)).toBe(3_600_000);
    expect(parseRetryAfter("garbage", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(decideAfterTransientFailure(1, 8, now, 5_000)).toEqual({ status: "FAILED", nextAttemptAt: new Date(now.getTime() + 5_000) });
  });
});

describe("health thresholds", () => {
  it("is HEALTHY below 3, DEGRADED from 3, FAILING from 10 consecutive failures", () => {
    expect([DEGRADED_AFTER, FAILING_AFTER]).toEqual([3, 10]);
    expect([0, 1, 2].map(healthFor)).toEqual(["HEALTHY", "HEALTHY", "HEALTHY"]);
    expect([3, 9].map(healthFor)).toEqual(["DEGRADED", "DEGRADED"]);
    expect([10, 50].map(healthFor)).toEqual(["FAILING", "FAILING"]);
  });
});

describe("integration actor permissions", () => {
  const allowed = new Set(["products.manage", "products.view", "orders.manage", "orders.view"]);

  it("the allowlist is exactly products.manage and orders.manage", () => {
    expect([...ALLOWED_GRANTS]).toEqual(["products.manage", "orders.manage"]);
  });

  it("never yields inventory.*, warehouse.*, picking.manage, packing.manage or any other permission, whatever is asked for", () => {
    const forbidden = PERMISSIONS.filter((p) => !allowed.has(p));
    const everything = [...PERMISSIONS, "inventory.adjust", "inventory.reserve", "inventory.view", "warehouse.design", "picking.manage", "packing.manage", "integrations.manage", "org.manage", "*", "inventory.*"];
    for (const subset of [[], ["products.manage"], ["orders.manage"], ["products.manage", "orders.manage"], everything]) {
      const perms = integrationPermissions(subset);
      for (const f of forbidden) expect(perms.has(f), `${f} must never be granted`).toBe(false);
      expect([...perms].every((p) => allowed.has(p))).toBe(true);
    }
    expect([...integrationPermissions(everything)].sort()).toEqual(["orders.manage", "orders.view", "products.manage", "products.view"]);
    expect(integrationPermissions([]).size).toBe(0);
  });
});

describe("outbound address policy", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.5", "203.0.113.9",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "2001:db8::1", "2002:7f00:1::1", "2001::1",
    "not-an-ip", "999.1.1.1", "",
  ])("refuses %s", (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.1", "11.0.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"])(
    "allows the public address %s",
    (address) => {
      expect(isForbiddenAddress(address)).toBe(false);
    },
  );
});

describe("webhook signatures", () => {
  const secret = "s3cret-value-for-tests-only";
  const body = JSON.stringify({ eventId: "e1", type: "order.cancel", occurredAt: "2026-01-01T00:00:00Z", data: { externalId: "X" } });
  const now = new Date("2026-10-06T12:00:00Z");
  const t = Math.floor(now.getTime() / 1000);

  it("accepts a correct signature within the tolerance window", () => {
    expect(verifySignature({ header: signatureHeaderValue(secret, t, body), rawBody: body, secrets: [secret], now })).toBe("ok");
    expect(verifySignature({ header: signatureHeaderValue(secret, t - 299, body), rawBody: body, secrets: [secret], now })).toBe("ok");
    expect(verifySignature({ header: signatureHeaderValue(secret, t + 299, body), rawBody: body, secrets: [secret], now })).toBe("ok");
  });

  it("rejects a stale or future timestamp even when the signature is valid", () => {
    expect(verifySignature({ header: signatureHeaderValue(secret, t - 301, body), rawBody: body, secrets: [secret], now })).toBe("stale");
    expect(verifySignature({ header: signatureHeaderValue(secret, t + 301, body), rawBody: body, secrets: [secret], now })).toBe("stale");
  });

  it("rejects a tampered body, wrong secret, wrong timestamp and malformed headers", () => {
    const header = signatureHeaderValue(secret, t, body);
    expect(verifySignature({ header, rawBody: body + " ", secrets: [secret], now })).toBe("invalid");
    expect(verifySignature({ header, rawBody: body, secrets: ["other-secret-value-xx"], now })).toBe("invalid");
    expect(verifySignature({ header: header.replace(`t=${t}`, `t=${t + 1}`), rawBody: body, secrets: [secret], now })).toBe("invalid");
    for (const bad of [null, "", "garbage", `t=${t}`, `v1=${"a".repeat(64)}`, `t=abc,v1=${"a".repeat(64)}`, `t=${t},v1=short`, `t=${t},v1=${"z".repeat(64)}`, "x".repeat(2000)]) {
      expect(verifySignature({ header: bad, rawBody: body, secrets: [secret], now })).toBe("invalid");
    }
    expect(verifySignature({ header, rawBody: body, secrets: [], now })).toBe("invalid");
  });

  it("accepts any of several candidate secrets (rotation) and any of several v1 values", () => {
    const oldSecret = "the-previous-secret-value";
    const header = signatureHeaderValue(oldSecret, t, body);
    expect(verifySignature({ header, rawBody: body, secrets: [secret, oldSecret], now })).toBe("ok");
    const both = `t=${t},v1=${computeSignature("unrelated-secret-value-1", t, body)},v1=${computeSignature(secret, t, body)}`;
    expect(verifySignature({ header: both, rawBody: body, secrets: [secret], now })).toBe("ok");
  });

  it("parses the header format t=<unix>,v1=<hex>", () => {
    const sig = computeSignature(secret, 1700000000, body);
    expect(parseSignatureHeader(`t=1700000000,v1=${sig}`)).toEqual({ timestamp: 1700000000, signatures: [sig] });
    expect(parseSignatureHeader(` t=1700000000 , v1=${sig.toUpperCase()} `)).toEqual({ timestamp: 1700000000, signatures: [sig] });
  });
});

describe("vault keyring parsing", () => {
  const key = (s: string) => Buffer.from(s.padEnd(32, "x")).toString("base64");
  it("the first entry is the active key; every key must decode to 32 bytes", () => {
    const ring = parseKeyring(`k2:${key("two")},k1:${key("one")}`);
    expect(ring.activeKeyId).toBe("k2");
    expect([...ring.keys.keys()]).toEqual(["k2", "k1"]);
    expect(ring.keys.get("k1")).toHaveLength(32);
  });

  it("rejects malformed rings without echoing key material", () => {
    for (const bad of ["", "   ", "nocolon", ":abc", `k1:${Buffer.from("short").toString("base64")}`, `bad id:${key("a")}`, `k1:${key("a")},k1:${key("b")}`, "k1:!!!notbase64!!!"]) {
      expect(() => parseKeyring(bad), bad).toThrow();
    }
    try {
      parseKeyring(`k1:${Buffer.from("tiny-secret-key-material").toString("base64")}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(Buffer.from("tiny-secret-key-material").toString("base64"));
    }
  });
});

describe("redaction", () => {
  it("masks bearer tokens, connection strings, URL credentials, long tokens and known secrets", () => {
    const text = redactText("failed Bearer abc.def.ghi at postgresql://u:pw@host/db and https://user:pass@example.com/x token=" + "A".repeat(40) + " plus hunter2-secret");
    expect(text).not.toMatch(/abc\.def\.ghi|u:pw|user:pass|A{32}/);
    expect(redactText("value hunter2-secret end", 300, ["hunter2-secret"])).toBe("value [redacted] end");
  });

  it("strips control characters and truncates", () => {
    expect(redactText("a\u0000b\nc\td")).toBe("a b c d");
    expect(redactText("word ".repeat(100), 50)).toHaveLength(50);
  });

  it("finds secret-looking keys at any depth", () => {
    expect(findSecretLookingKeys({ a: 1, nested: { apiKey: "x", list: [{ Authorization: "y" }] }, password: "p", my_token: "t", clientSecret: "s" }).sort()).toEqual([
      "clientSecret",
      "my_token",
      "nested.apiKey",
      "nested.list[0].Authorization",
      "password",
    ]);
    expect(findSecretLookingKeys({ targetUrl: "https://x", subscribedEvents: ["order.packed"], maxAttempts: 3 })).toEqual([]);
  });
});

describe("generic webhook configuration", () => {
  it("accepts a clean configuration and applies defaults", () => {
    expect(genericWebhookConfigSchema.parse({})).toEqual({ subscribedEvents: [] });
    expect(genericWebhookConfigSchema.parse({ targetUrl: "https://example.com/hook", subscribedEvents: ["order.packed", "order.packed"], maxAttempts: 5 })).toEqual({
      targetUrl: "https://example.com/hook",
      subscribedEvents: ["order.packed"],
      maxAttempts: 5,
    });
  });

  it("rejects unknown keys, unknown event types and out-of-range attempts", () => {
    expect(genericWebhookConfigSchema.safeParse({ apiKey: "x" }).success).toBe(false);
    expect(genericWebhookConfigSchema.safeParse({ subscribedEvents: ["inventory.changed"] }).success).toBe(false);
    expect(genericWebhookConfigSchema.safeParse({ maxAttempts: 0 }).success).toBe(false);
    expect(genericWebhookConfigSchema.safeParse({ maxAttempts: 13 }).success).toBe(false);
  });

  it("keeps credentials out of the target URL and requires https in production", () => {
    expect(targetUrlProblem("https://user:pass@example.com/", true)).toMatch(/credentials/);
    expect(targetUrlProblem("https://example.com/hook?token=abc", true)).toMatch(/query/);
    expect(targetUrlProblem("https://example.com/hook#frag", true)).toMatch(/query|fragment/);
    expect(targetUrlProblem("http://example.com/hook", true)).toMatch(/https/);
    expect(targetUrlProblem("http://example.com/hook", false)).toBeNull();
    expect(targetUrlProblem("ftp://example.com/hook", false)).toMatch(/https/);
    expect(targetUrlProblem("not a url", false)).toMatch(/valid/);
    expect(targetUrlProblem("https://example.com/hook", true)).toBeNull();
  });
});

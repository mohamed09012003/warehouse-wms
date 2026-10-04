import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";

const good = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/warehouse_wms",
  AUTH_SECRET: "x".repeat(32),
};

describe("environment validation", () => {
  it("accepts a complete configuration", () => {
    expect(parseEnv(good).DATABASE_URL).toBe(good.DATABASE_URL);
  });

  it("rejects missing variables", () => {
    expect(() => parseEnv({})).toThrow(/DATABASE_URL.*AUTH_SECRET|AUTH_SECRET.*DATABASE_URL/);
  });

  it("rejects a short AUTH_SECRET and a non-postgres URL", () => {
    expect(() => parseEnv({ ...good, AUTH_SECRET: "short" })).toThrow(/AUTH_SECRET/);
    expect(() => parseEnv({ ...good, DATABASE_URL: "mysql://x" })).toThrow(/DATABASE_URL/);
  });

  it("does not echo secret values in the error", () => {
    try {
      parseEnv({ DATABASE_URL: "mysql://user:hunter2@host/db", AUTH_SECRET: "tooshort-secret" });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
      expect((error as Error).message).not.toContain("tooshort-secret");
    }
  });

  describe("integration vault keys", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
    it("is optional, accepts a valid keyring and an empty value", () => {
      expect(parseEnv(good).INTEGRATION_ENCRYPTION_KEYS).toBeUndefined();
      expect(parseEnv({ ...good, INTEGRATION_ENCRYPTION_KEYS: "" }).INTEGRATION_ENCRYPTION_KEYS).toBe("");
      expect(parseEnv({ ...good, INTEGRATION_ENCRYPTION_KEYS: "k1:" + key + ",k0:" + key }).INTEGRATION_ENCRYPTION_KEYS).toContain("k1:");
    });

    it("rejects malformed keys without echoing them", () => {
      const bad = "k1:" + Buffer.from("too-short-key-material").toString("base64");
      try {
        parseEnv({ ...good, INTEGRATION_ENCRYPTION_KEYS: bad });
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toMatch(/INTEGRATION_ENCRYPTION_KEYS/);
        expect((error as Error).message).not.toContain(Buffer.from("too-short-key-material").toString("base64"));
      }
      expect(() => parseEnv({ ...good, INTEGRATION_ENCRYPTION_KEYS: "nonsense" })).toThrow(/INTEGRATION_ENCRYPTION_KEYS/);
    });

    it("only accepts true/false for the private-target override", () => {
      expect(parseEnv({ ...good, INTEGRATIONS_ALLOW_PRIVATE_TARGETS: "true" }).INTEGRATIONS_ALLOW_PRIVATE_TARGETS).toBe("true");
      expect(() => parseEnv({ ...good, INTEGRATIONS_ALLOW_PRIVATE_TARGETS: "yes" })).toThrow(/INTEGRATIONS_ALLOW_PRIVATE_TARGETS/);
    });
  });
});

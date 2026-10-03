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
});

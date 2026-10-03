import { describe, expect, it } from "vitest";
import { assertDevDatabase, assertTestDatabase, databaseNameFromUrl } from "../safety";

const dev = "postgresql://u:secret-pw@localhost:5432/warehouse_wms";
const test = "postgresql://u:secret-pw@localhost:5432/warehouse_wms_test";

describe("test database protection", () => {
  it("accepts the dedicated test database", () => {
    expect(assertTestDatabase(test, dev)).toBe("warehouse_wms_test");
  });

  it("refuses the development database", () => {
    expect(() => assertTestDatabase(dev)).toThrow(/development database/);
  });

  it("refuses any other database name", () => {
    expect(() => assertTestDatabase("postgresql://u:p@localhost/other")).toThrow(/must be named/);
  });

  it("refuses a missing or malformed URL", () => {
    expect(() => assertTestDatabase(undefined)).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => assertTestDatabase("not a url")).toThrow();
  });

  it("refuses when the dev and test URLs name the same database", () => {
    expect(() => assertTestDatabase(test, test)).toThrow(/same database/);
  });

  it("never puts the connection string or password in error messages", () => {
    for (const bad of [dev, "postgresql://u:secret-pw@localhost/other"]) {
      try {
        assertTestDatabase(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain("secret-pw");
      }
    }
  });
});

describe("development database check", () => {
  it("accepts only warehouse_wms", () => {
    expect(assertDevDatabase(dev)).toBe("warehouse_wms");
    expect(() => assertDevDatabase(test)).toThrow();
  });
});

describe("this test run", () => {
  it("is connected to warehouse_wms_test, never warehouse_wms", () => {
    expect(databaseNameFromUrl(process.env.DATABASE_URL)).toBe("warehouse_wms_test");
    expect(databaseNameFromUrl(process.env.TEST_DATABASE_URL)).toBe("warehouse_wms_test");
  });
});

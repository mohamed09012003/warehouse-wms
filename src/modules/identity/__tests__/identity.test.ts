import { beforeEach, describe, expect, it } from "vitest";
import { fakeOrg, prisma, resetDatabase } from "../../../../tests/support/db";
import { authenticateWithPassword, createUser, hashPassword, verifyPassword } from "..";

describe("password hashing", () => {
  it("verifies the right password and rejects wrong ones", async () => {
    const hash = await hashPassword("a-long-test-password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("a-long-test-password", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("salts: same password hashes differently", async () => {
    expect(await hashPassword("same-password-1")).not.toBe(await hashPassword("same-password-1"));
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("authenticateWithPassword", () => {
  const { owner } = fakeOrg("auth");

  beforeEach(async () => {
    await resetDatabase();
    await createUser(owner);
  });

  it("returns the user for valid credentials (email is case-insensitive)", async () => {
    const user = await authenticateWithPassword({ email: owner.email.toUpperCase(), password: owner.password });
    expect(user?.email).toBe(owner.email);
  });

  it("returns null for wrong password, unknown email, bad input", async () => {
    expect(await authenticateWithPassword({ email: owner.email, password: "nope" })).toBeNull();
    expect(await authenticateWithPassword({ email: "nobody@example.test", password: "x" })).toBeNull();
    expect(await authenticateWithPassword({ email: 5 })).toBeNull();
  });

  it("returns null for a disabled user", async () => {
    await prisma.user.update({ where: { email: owner.email }, data: { disabledAt: new Date() } });
    expect(await authenticateWithPassword({ email: owner.email, password: owner.password })).toBeNull();
  });

  it("never stores the plaintext password", async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { email: owner.email } });
    expect(row.passwordHash).not.toContain(owner.password);
  });
});

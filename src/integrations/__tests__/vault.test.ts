// The secret vault: AES-256-GCM with AAD binding, key rotation, the secret store and the single decryption boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseKeyring } from "@/lib/keyring";
import { prisma, resetDatabase } from "../../../tests/support/db";
import { canary, newIntegration } from "../../../tests/support/integrations";
import { newTenant } from "../../../tests/support/fixtures";
import { secretStore, SECRET_ROTATION_GRACE_MS } from "../secrets/secretStore";
import { decryptSecret, encryptSecret, secretAad, VaultError } from "../secrets/vault";

const key = (s: string) => Buffer.from(s).toString("base64");
const ringA = parseKeyring(`ka:${key("0123456789abcdef0123456789abcdef")}`);
const ringBoth = parseKeyring(`kb:${key("fedcba9876543210fedcba9876543210")},ka:${key("0123456789abcdef0123456789abcdef")}`);
const aad = secretAad("org-1", "int-1", "inbound_signing_secret");

describe("vault crypto", () => {
  it("round-trips and never stores the plaintext in the ciphertext", () => {
    const secret = canary("rt");
    const blob = encryptSecret(secret, aad, ringA);
    expect(decryptSecret(blob, aad, ringA)).toBe(secret);
    expect(blob.ciphertext.includes(Buffer.from(secret))).toBe(false);
    expect(blob.iv).toHaveLength(12);
    expect(blob.authTag).toHaveLength(16);
    expect(blob.keyId).toBe("ka");
  });

  it("uses a fresh random IV every time", () => {
    const a = encryptSecret("same-value-same-value", aad, ringA);
    const b = encryptSecret("same-value-same-value", aad, ringA);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails authentication for a different organization, integration or secret name (AAD binding)", () => {
    const blob = encryptSecret(canary("aad"), aad, ringA);
    for (const other of [secretAad("org-2", "int-1", "inbound_signing_secret"), secretAad("org-1", "int-2", "inbound_signing_secret"), secretAad("org-1", "int-1", "outbound_signing_secret")]) {
      expect(() => decryptSecret(blob, other, ringA)).toThrow(VaultError);
    }
  });

  it("fails for a tampered ciphertext, auth tag or IV, and for an unknown key id", () => {
    const blob = encryptSecret(canary("tamper"), aad, ringA);
    const flip = (b: Buffer) => Buffer.concat([Buffer.from([b[0] ^ 1]), b.subarray(1)]);
    expect(() => decryptSecret({ ...blob, ciphertext: flip(blob.ciphertext) }, aad, ringA)).toThrow(VaultError);
    expect(() => decryptSecret({ ...blob, authTag: flip(blob.authTag) }, aad, ringA)).toThrow(VaultError);
    expect(() => decryptSecret({ ...blob, iv: flip(blob.iv) }, aad, ringA)).toThrow(VaultError);
    expect(() => decryptSecret({ ...blob, keyId: "nope" }, aad, ringA)).toThrow(VaultError);
  });

  it("supports key rotation: old ciphertext still decrypts, new ciphertext uses the new active key", () => {
    const old = encryptSecret("old-secret-old-secret", aad, ringA);
    expect(decryptSecret(old, aad, ringBoth)).toBe("old-secret-old-secret");
    const fresh = encryptSecret("new-secret-new-secret", aad, ringBoth);
    expect(fresh.keyId).toBe("kb");
    expect(() => decryptSecret(fresh, aad, ringA)).toThrow(VaultError); // ring A does not know kb
  });

  it("error messages contain neither plaintext nor key material", () => {
    const secret = canary("msg");
    const blob = encryptSecret(secret, aad, ringA);
    try {
      decryptSecret(blob, secretAad("x", "y", "z"), ringA);
      expect.unreachable();
    } catch (error) {
      const text = String((error as Error).message) + JSON.stringify(error);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(key("0123456789abcdef0123456789abcdef"));
    }
  });
});

describe("secret store", () => {
  beforeEach(resetDatabase);

  it("stores encrypted, reads back inside the process, and reports metadata only", async () => {
    const t = await newTenant("vs");
    const integ = await newIntegration(t.ctx, { enable: false });
    const org = t.ctx.organizationId;
    const value = canary("store");
    await secretStore.put(org, integ.id, "inbound_signing_secret", value);

    expect((await secretStore.read(org, integ.id, "inbound_signing_secret")).current).toBe(value);
    const rows = await prisma.integrationSecret.findMany({ where: { integrationId: integ.id, name: "inbound_signing_secret" } });
    const current = rows.find((r) => r.slot === "CURRENT")!;
    expect(Buffer.from(current.ciphertext).includes(Buffer.from(value))).toBe(false);
    expect(current.keyId).toBe("test1");

    const [meta] = await secretStore.metadata(org, integ.id, ["inbound_signing_secret"]);
    expect(Object.keys(meta).sort()).toEqual(["hasPrevious", "isSet", "name", "rotatedAt"]);
    expect(meta.isSet).toBe(true);
    expect(JSON.stringify(meta)).not.toContain(value);
  });

  it("rotation keeps the previous value for the grace period only", async () => {
    const t = await newTenant("vs");
    const integ = await newIntegration(t.ctx, { enable: false });
    const org = t.ctx.organizationId;
    const t0 = new Date("2026-10-06T10:00:00Z");
    await secretStore.put(org, integ.id, "inbound_signing_secret", "first-secret-value-1", t0);
    const t1 = new Date(t0.getTime() + 3600_000);
    await secretStore.put(org, integ.id, "inbound_signing_secret", "second-secret-value-2", t1);

    expect(await secretStore.read(org, integ.id, "inbound_signing_secret", new Date(t1.getTime() + 60_000))).toEqual({ current: "second-secret-value-2", previous: "first-secret-value-1" });
    const afterGrace = new Date(t1.getTime() + SECRET_ROTATION_GRACE_MS + 1);
    expect(await secretStore.read(org, integ.id, "inbound_signing_secret", afterGrace)).toEqual({ current: "second-secret-value-2" });
    expect((await secretStore.metadata(org, integ.id, ["inbound_signing_secret"], t1))[0].hasPrevious).toBe(true);
    expect((await secretStore.metadata(org, integ.id, ["inbound_signing_secret"], afterGrace))[0].hasPrevious).toBe(false);

    // A third rotation replaces the oldest value: only one PREVIOUS ever exists.
    await secretStore.put(org, integ.id, "inbound_signing_secret", "third-secret-value-3", new Date(t1.getTime() + 7200_000));
    const rows = await prisma.integrationSecret.findMany({ where: { integrationId: integ.id, name: "inbound_signing_secret" }, orderBy: { slot: "asc" } });
    expect(rows.map((r) => r.slot)).toEqual(["CURRENT", "PREVIOUS"]);
    expect((await secretStore.read(org, integ.id, "inbound_signing_secret", new Date(t1.getTime() + 7300_000))).previous).toBe("second-secret-value-2");
  });

  it("remove deletes every slot", async () => {
    const t = await newTenant("vs");
    const integ = await newIntegration(t.ctx, { enable: false });
    await secretStore.put(t.ctx.organizationId, integ.id, "inbound_signing_secret", "rotate-me-secret-aaa");
    await secretStore.put(t.ctx.organizationId, integ.id, "inbound_signing_secret", "rotate-me-secret-bbb");
    expect(await secretStore.remove(t.ctx.organizationId, integ.id, "inbound_signing_secret")).toBe(2);
    expect(await secretStore.read(t.ctx.organizationId, integ.id, "inbound_signing_secret")).toEqual({});
  });

  it("a ciphertext copied to another tenant, another integration or another name cannot be decrypted", async () => {
    const a = await newTenant("ca");
    const b = await newTenant("cb");
    const ia = await newIntegration(a.ctx, { enable: false });
    const ib = await newIntegration(b.ctx, { enable: false });
    const ia2 = await newIntegration(a.ctx, { enable: false });
    const original = await prisma.integrationSecret.findFirstOrThrow({ where: { integrationId: ia.id, name: "inbound_signing_secret" } });

    // Move the stolen ciphertext into tenant B's integration (the composite FK is satisfied: it is B's own row).
    await prisma.integrationSecret.deleteMany({ where: { integrationId: ib.id, name: "inbound_signing_secret" } });
    await prisma.integrationSecret.create({
      data: { organizationId: b.ctx.organizationId, integrationId: ib.id, name: "inbound_signing_secret", slot: "CURRENT", ciphertext: original.ciphertext, iv: original.iv, authTag: original.authTag, keyId: original.keyId },
    });
    await expect(secretStore.read(b.ctx.organizationId, ib.id, "inbound_signing_secret")).rejects.toMatchObject({ code: "SECRET_UNREADABLE" });

    // Same organization, different integration.
    await prisma.integrationSecret.deleteMany({ where: { integrationId: ia2.id, name: "inbound_signing_secret" } });
    await prisma.integrationSecret.create({
      data: { organizationId: a.ctx.organizationId, integrationId: ia2.id, name: "inbound_signing_secret", slot: "CURRENT", ciphertext: original.ciphertext, iv: original.iv, authTag: original.authTag, keyId: original.keyId },
    });
    await expect(secretStore.read(a.ctx.organizationId, ia2.id, "inbound_signing_secret")).rejects.toBeInstanceOf(VaultError);

    // Same integration, different secret name.
    await prisma.integrationSecret.create({
      data: { organizationId: a.ctx.organizationId, integrationId: ia.id, name: "outbound_signing_secret", slot: "CURRENT", ciphertext: original.ciphertext, iv: original.iv, authTag: original.authTag, keyId: original.keyId },
    });
    await expect(secretStore.read(a.ctx.organizationId, ia.id, "outbound_signing_secret")).rejects.toBeInstanceOf(VaultError);
    // The original still works.
    expect((await secretStore.read(a.ctx.organizationId, ia.id, "inbound_signing_secret")).current).toBe(ia.inboundSecret);
  });

  it("the database refuses a secret row that points at another tenant's integration (composite FK)", async () => {
    const a = await newTenant("fa");
    const b = await newTenant("fb");
    const ia = await newIntegration(a.ctx, { enable: false });
    await expect(
      prisma.integrationSecret.create({
        data: { organizationId: b.ctx.organizationId, integrationId: ia.id, name: "inbound_signing_secret", slot: "PREVIOUS", ciphertext: new Uint8Array([1, 2, 3]), iv: new Uint8Array(12), authTag: new Uint8Array(16), keyId: "k" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("rejects malformed secret rows at the database level (name, iv and tag sizes)", async () => {
    const t = await newTenant("ck");
    const integ = await newIntegration(t.ctx, { enable: false });
    const base = { organizationId: t.ctx.organizationId, integrationId: integ.id, slot: "PREVIOUS" as const, ciphertext: new Uint8Array([1]), keyId: "k" };
    await expect(prisma.integrationSecret.create({ data: { ...base, name: "Bad Name", iv: new Uint8Array(12), authTag: new Uint8Array(16) } })).rejects.toBeTruthy();
    await expect(prisma.integrationSecret.create({ data: { ...base, name: "ok_name", iv: new Uint8Array(8), authTag: new Uint8Array(16) } })).rejects.toBeTruthy();
    await expect(prisma.integrationSecret.create({ data: { ...base, name: "ok_name", iv: new Uint8Array(12), authTag: new Uint8Array(4) } })).rejects.toBeTruthy();
  });
});

describe("the decryption boundary", () => {
  const walk = (dir: string): string[] =>
    (fs.readdirSync(dir, { recursive: true }) as string[])
      .map((f) => path.join(dir, f))
      .filter((f) => /\.(ts|tsx)$/.test(f) && fs.statSync(f).isFile() && !f.includes("__tests__") && !f.includes(`${path.sep}generated${path.sep}`));

  it("only secrets/secretStore.ts decrypts, and only it reads IntegrationSecret", () => {
    const files = walk(path.resolve("src"));
    const decrypts = files.filter((f) => /\bdecryptSecret\b/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f));
    expect(decrypts.sort()).toEqual(["secretStore.ts", "vault.ts"]);
    const readers = files.filter((f) => /\.integrationSecret\./.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f));
    expect(readers).toEqual(["secretStore.ts"]);
    // the repositories select explicit columns and never a secret table
    const code = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\/.*$/gm, "");
    for (const f of files.filter((f) => f.includes(`${path.sep}repo${path.sep}`))) expect(code(f)).not.toMatch(/integrationSecret|IntegrationSecret/);
  });

  it("no code outside the HTTP client touches the network", () => {
    const offenders = walk(path.resolve("src/integrations"))
      .filter((f) => !f.endsWith(`http${path.sep}safeHttpClient.ts`))
      .filter((f) => /\bfetch\(|node:http|node:https|from "axios"|from "undici"|node-fetch/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(process.cwd(), f));
    expect(offenders).toEqual([]);
  });

  it("keeps the unused-id helper honest", () => {
    expect(randomUUID()).toHaveLength(36);
  });
});

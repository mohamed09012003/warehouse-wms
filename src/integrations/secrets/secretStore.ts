// The secrets repository: the ONLY code that reads IntegrationSecret and the ONLY place a secret is
// decrypted. Everything else sees metadata (name, isSet, rotatedAt) or, inside one operation, the plaintext
// handed over by `read`/`readMany` (never stored, never logged).
import "server-only";
import { prisma } from "@/server/db/client";
import type { SecretValue, SecretValues } from "../core/types";
import { decryptSecret, encryptSecret, getKeyring, secretAad } from "./vault";

/** After a rotation the PREVIOUS value is still honoured (inbound signatures) for this long. */
export const SECRET_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

export interface SecretMetadata {
  name: string;
  isSet: boolean;
  rotatedAt: Date | null;
  /** A previous value is still within its grace period. */
  hasPrevious: boolean;
}

export const secretStore = {
  /** Encrypt and store a new CURRENT value; the old CURRENT becomes PREVIOUS (replacing any older PREVIOUS). */
  async put(organizationId: string, integrationId: string, name: string, value: string, now = new Date()): Promise<{ rotatedAt: Date }> {
    const encrypted = encryptSecret(value, secretAad(organizationId, integrationId, name), getKeyring());
    await prisma.$transaction(async (tx) => {
      const current = await tx.integrationSecret.findUnique({
        where: { integrationId_name_slot: { integrationId, name, slot: "CURRENT" } },
        select: { id: true },
      });
      if (current) {
        await tx.integrationSecret.deleteMany({ where: { integrationId, name, slot: "PREVIOUS" } });
        await tx.integrationSecret.update({ where: { id: current.id }, data: { slot: "PREVIOUS" } });
      }
      await tx.integrationSecret.create({
        data: {
          organizationId,
          integrationId,
          name,
          slot: "CURRENT",
          ciphertext: new Uint8Array(encrypted.ciphertext),
          iv: new Uint8Array(encrypted.iv),
          authTag: new Uint8Array(encrypted.authTag),
          keyId: encrypted.keyId,
          rotatedAt: now,
        },
      });
    });
    return { rotatedAt: now };
  },

  /** Delete both slots of a secret. Returns the number of rows removed. */
  async remove(organizationId: string, integrationId: string, name: string): Promise<number> {
    return (await prisma.integrationSecret.deleteMany({ where: { organizationId, integrationId, name } })).count;
  },

  /** Names and rotation times only: ciphertext columns are never selected. */
  async metadata(organizationId: string, integrationId: string, names: readonly string[], now = new Date()): Promise<SecretMetadata[]> {
    const rows = await prisma.integrationSecret.findMany({
      where: { organizationId, integrationId },
      select: { name: true, slot: true, rotatedAt: true },
    });
    return names.map((name) => {
      const current = rows.find((r) => r.name === name && r.slot === "CURRENT");
      const previous = rows.find((r) => r.name === name && r.slot === "PREVIOUS");
      return {
        name,
        isSet: !!current,
        rotatedAt: current?.rotatedAt ?? null,
        hasPrevious: !!current && !!previous && now.getTime() < current.rotatedAt.getTime() + SECRET_ROTATION_GRACE_MS,
      };
    });
  },

  /** Decrypt one secret (the decryption boundary). Throws VaultError if a stored value cannot be authenticated. */
  async read(organizationId: string, integrationId: string, name: string, now = new Date()): Promise<SecretValue> {
    const rows = await prisma.integrationSecret.findMany({ where: { organizationId, integrationId, name } });
    const current = rows.find((r) => r.slot === "CURRENT");
    if (!current) return {};
    const aad = secretAad(organizationId, integrationId, name);
    const keyring = getKeyring();
    const toBlob = (r: (typeof rows)[number]) => ({ ciphertext: Buffer.from(r.ciphertext), iv: Buffer.from(r.iv), authTag: Buffer.from(r.authTag), keyId: r.keyId });
    const out: SecretValue = { current: decryptSecret(toBlob(current), aad, keyring) };
    const previous = rows.find((r) => r.slot === "PREVIOUS");
    if (previous && now.getTime() < current.rotatedAt.getTime() + SECRET_ROTATION_GRACE_MS) {
      out.previous = decryptSecret(toBlob(previous), aad, keyring);
    }
    return out;
  },

  async readMany(organizationId: string, integrationId: string, names: readonly string[], now = new Date()): Promise<SecretValues> {
    const out: Record<string, SecretValue> = {};
    for (const name of names) out[name] = await secretStore.read(organizationId, integrationId, name, now);
    return out;
  },
};

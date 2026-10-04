// AES-256-GCM envelope for integration secrets (node:crypto only).
//
// Each value is encrypted with the ACTIVE key of the keyring and a fresh random 96-bit IV. The
// additional authenticated data (AAD) binds the ciphertext to its organization, integration and secret
// name, so a ciphertext copied to another tenant, integration or name fails authentication on decrypt.
//
// `decryptSecret` must be imported ONLY by secrets/secretStore.ts (the single decryption boundary);
// a test scans the source tree to keep it that way. Error messages never contain key material or plaintext.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseKeyring, type Keyring } from "@/lib/keyring";
import { getEnv } from "@/server/env";

export class VaultError extends Error {
  constructor(
    readonly code: "VAULT_NOT_CONFIGURED" | "SECRET_UNREADABLE",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
}

let cached: { raw: string; keyring: Keyring } | undefined;

/** The configured keyring; throws VAULT_NOT_CONFIGURED when INTEGRATION_ENCRYPTION_KEYS is unset. */
export function getKeyring(): Keyring {
  const raw = getEnv().INTEGRATION_ENCRYPTION_KEYS?.trim();
  if (!raw) throw new VaultError("VAULT_NOT_CONFIGURED", "INTEGRATION_ENCRYPTION_KEYS is not configured");
  if (cached?.raw !== raw) cached = { raw, keyring: parseKeyring(raw) };
  return cached.keyring;
}

export function secretAad(organizationId: string, integrationId: string, name: string): Buffer {
  return Buffer.from(`wms-integration-secret/v1|${organizationId}|${integrationId}|${name}`, "utf8");
}

export function encryptSecret(plaintext: string, aad: Buffer, keyring: Keyring = getKeyring()): EncryptedSecret {
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new VaultError("VAULT_NOT_CONFIGURED", "The active encryption key is missing");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyId: keyring.activeKeyId };
}

export function decryptSecret(blob: EncryptedSecret, aad: Buffer, keyring: Keyring = getKeyring()): string {
  const key = keyring.keys.get(blob.keyId);
  if (!key) throw new VaultError("SECRET_UNREADABLE", "The secret was encrypted with a key that is no longer configured");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, blob.iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(blob.authTag);
    return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, tampering, or a ciphertext moved to another tenant/integration/name.
    throw new VaultError("SECRET_UNREADABLE", "The secret could not be decrypted");
  }
}

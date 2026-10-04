// Parser for INTEGRATION_ENCRYPTION_KEYS: "keyId:base64key[,keyId2:base64key2...]".
// Every key is exactly 32 bytes (AES-256). The FIRST entry is the active key used for new
// encryptions; the others stay available for decrypting older ciphertext (key rotation).
// Error messages never contain key material.

export interface Keyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}

const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function parseKeyring(raw: string): Keyring {
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("INTEGRATION_ENCRYPTION_KEYS is empty");
  const keys = new Map<string, Buffer>();
  entries.forEach((entry, index) => {
    const at = entry.indexOf(":");
    const id = at > 0 ? entry.slice(0, at) : "";
    const b64 = at > 0 ? entry.slice(at + 1) : "";
    if (!KEY_ID.test(id) || !BASE64.test(b64)) {
      throw new Error(`INTEGRATION_ENCRYPTION_KEYS entry ${index + 1} must look like keyId:base64(32 bytes)`);
    }
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) throw new Error(`INTEGRATION_ENCRYPTION_KEYS entry ${index + 1} must decode to exactly 32 bytes`);
    if (keys.has(id)) throw new Error(`INTEGRATION_ENCRYPTION_KEYS repeats key id "${id}"`);
    keys.set(id, key);
  });
  return { activeKeyId: entries[0].slice(0, entries[0].indexOf(":")), keys };
}

export function isValidKeyring(raw: string): boolean {
  try {
    parseKeyring(raw);
    return true;
  } catch {
    return false;
  }
}

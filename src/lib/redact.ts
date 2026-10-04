// Helpers that keep credentials and bulky/untrusted text out of logs, error summaries and audit rows.
// Nothing here is a substitute for not handling secrets in the first place: call sites pass only
// codes and short static text. These helpers are the last line of defence.

/** Object keys that must never appear in stored configuration or log context. */
const SECRET_KEY = /(secret|token|passw(or)?d|passwd|api[-_]?key|apikey|authorization|credential|private[-_]?key|bearer|signature|cookie|auth[-_]?header)/i;

export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Dotted paths of every key (any depth) that looks like it would hold a secret. */
export function findSecretLookingKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecretLookingKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const here = path ? `${path}.${k}` : k;
      return [...(looksLikeSecretKey(k) ? [here] : []), ...findSecretLookingKeys(v, here)];
    });
  }
  return [];
}

/**
 * Make free text safe to store: masks bearer tokens, connection strings, URL credentials and long
 * token-like runs, removes control characters and truncates. `knownSecrets` (values the caller holds
 * in memory) are masked wherever they occur.
 */
export function redactText(text: string, max = 300, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  out = out
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb|redis|amqp):\/\/\S+/gi, "[redacted-url]")
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[redacted]@")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

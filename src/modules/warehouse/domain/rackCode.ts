// Rack codes are the first segment of a location code, so they cannot contain "-".
export const RACK_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

export function isValidRackCode(code: string): boolean {
  return RACK_CODE_PATTERN.test(code);
}

/** Suggest the next free "R01", "R02", ... code (a suggestion only; admins may choose any valid code). */
export function suggestNextRackCode(existingCodes: Iterable<string>): string {
  let max = 0;
  const taken = new Set<string>();
  for (const code of existingCodes) {
    taken.add(code);
    const m = /^R(\d+)$/.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  let candidate = `R${String(n).padStart(2, "0")}`;
  while (taken.has(candidate)) candidate = `R${String(++n).padStart(2, "0")}`;
  return candidate;
}

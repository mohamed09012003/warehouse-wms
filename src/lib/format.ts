/** Deterministic number formatting. Using the default locale differs between server and browser and breaks hydration. */
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

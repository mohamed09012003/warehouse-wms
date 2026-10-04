// Which destination addresses outbound integration calls may reach. Pure functions, no I/O.
// Anything that could be an internal service is refused: loopback, private, link-local (including
// cloud metadata at 169.254.169.254), carrier-grade NAT, multicast and reserved space, for both IPv4
// and IPv6 (including IPv4-mapped / NAT64 forms of those addresses).
import { isIP } from "node:net";

const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inV4(n: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

function isForbiddenV4(address: string): boolean {
  const n = v4ToInt(address);
  if (n === null) return true;
  return V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits));
}

/** Parse an IPv6 address into a 128-bit BigInt, or null if it is not valid. */
function parseV6(input: string): bigint | null {
  let address = input.split("%")[0];
  // Embedded IPv4 tail (::ffff:1.2.3.4)
  const tail = address.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = v4ToInt(tail[1]);
    if (v4 === null) return null;
    address = address.slice(0, -tail[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array<string>(missing).fill("0"), ...rest];
  let value = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return value;
}

function v6Prefix(value: bigint, prefix: string, bits: number): boolean {
  const base = parseV6(prefix)!;
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

function isForbiddenV6(address: string): boolean {
  const v = parseV6(address);
  if (v === null) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96): judge the embedded IPv4 address.
  if (v6Prefix(v, "::ffff:0:0", 96) || v6Prefix(v, "64:ff9b::", 96)) {
    const low = Number(v & BigInt(0xffffffff));
    return isForbiddenV4(`${Math.floor(low / 16777216)}.${Math.floor(low / 65536) % 256}.${Math.floor(low / 256) % 256}.${low % 256}`);
  }
  // Only global unicast space (2000::/3) is allowed, minus documentation, protocol-assignment and 6to4/Teredo ranges.
  if (!v6Prefix(v, "2000::", 3)) return true;
  return (
    v6Prefix(v, "2001::", 23) || // IETF protocol assignments incl. Teredo
    v6Prefix(v, "2001:db8::", 32) || // documentation
    v6Prefix(v, "2002::", 16) || // 6to4
    v6Prefix(v, "3fff::", 20) // documentation
  );
}

/** True when `address` (an IP literal) must not be contacted. Unparseable input counts as forbidden. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isForbiddenV4(address);
  if (family === 6) return isForbiddenV6(address);
  return true;
}

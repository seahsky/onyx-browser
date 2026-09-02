import net from "node:net";

export const DENIED_SCHEMES = ["file:", "chrome:", "devtools:", "view-source:"] as const;

export function isDeniedScheme(rawUrl: string): boolean {
  let scheme: string;
  try {
    scheme = new URL(rawUrl).protocol;
  } catch {
    return true; // unparseable — fail closed
  }
  return (DENIED_SCHEMES as readonly string[]).includes(scheme);
}

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .reduce((acc, part) => (acc << 8) | Number(part), 0) >>> 0;
}

interface Ipv4Range {
  base: number;
  maskBits: number;
}

function ipv4Range(cidrBase: string, maskBits: number): Ipv4Range {
  return { base: ipv4ToInt(cidrBase), maskBits };
}

function inIpv4Range(ipInt: number, range: Ipv4Range): boolean {
  if (range.maskBits === 0) return true;
  const mask = range.maskBits === 32 ? 0xffffffff : (~0 << (32 - range.maskBits)) >>> 0;
  return (ipInt & mask) === (range.base & mask);
}

// Exactly the ranges the build spec lists — loopback, the three RFC1918
// blocks, and link-local 169.254.0.0/16 (which already covers the cloud
// metadata address 169.254.169.254; it's listed separately in the spec for
// emphasis, not because it needs its own rule).
const DENIED_IPV4_RANGES: Ipv4Range[] = [
  ipv4Range("127.0.0.0", 8),
  ipv4Range("10.0.0.0", 8),
  ipv4Range("172.16.0.0", 12),
  ipv4Range("192.168.0.0", 16),
  ipv4Range("169.254.0.0", 16),
];

/**
 * Parses standard (non-embedded-IPv4, no zone id) IPv6 notation into a
 * 128-bit integer. Good enough for the loopback/ULA checks this needs;
 * doesn't attempt to handle every legal IPv6 literal form.
 */
function ipv6ToBigInt(ip: string): bigint | null {
  if (ip.includes("%")) return null;

  const hasDoubleColon = ip.includes("::");
  const [headStr, tailStr] = hasDoubleColon ? ip.split("::") : [ip, undefined];
  const headParts = headStr ? headStr.split(":").filter((p) => p.length > 0) : [];
  const tailParts = tailStr ? tailStr.split(":").filter((p) => p.length > 0) : [];

  if (!hasDoubleColon && headParts.length !== 8) return null;
  if (hasDoubleColon && headParts.length + tailParts.length >= 8) return null;

  const missing = hasDoubleColon ? 8 - headParts.length - tailParts.length : 0;
  const allParts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (allParts.length !== 8) return null;

  let result = 0n;
  for (const part of allParts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    result = (result << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return result;
}

function inIpv6Prefix(ipBig: bigint, prefixHex: string, prefixBits: number): boolean {
  const base = ipv6ToBigInt(prefixHex);
  if (base === null) return false;
  const shift = 128n - BigInt(prefixBits);
  const mask = prefixBits === 0 ? 0n : ((1n << BigInt(prefixBits)) - 1n) << shift;
  return (ipBig & mask) === (base & mask);
}

/** True for an address the egress guard must deny (unless ONYX_ALLOW_PRIVATE_NETWORK is set). */
export function isDeniedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const ipInt = ipv4ToInt(ip);
    return DENIED_IPV4_RANGES.some((range) => inIpv4Range(ipInt, range));
  }
  if (net.isIPv6(ip)) {
    const ipBig = ipv6ToBigInt(ip);
    if (ipBig === null) return true; // couldn't parse a claimed-valid IPv6 — fail closed
    if (ipBig === 1n) return true; // ::1 loopback
    if (inIpv6Prefix(ipBig, "fc00::", 7)) return true; // ULA
    return false;
  }
  return true; // not a recognizable IP at all — fail closed
}

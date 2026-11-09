/**
 * The client IP of a request, for rate limits and logs. Behind `SEVDESK_HTTP_TRUST_PROXY` = N
 * reverse proxies, the N-th `X-Forwarded-For` entry from the right is the address the outermost
 * trusted proxy saw; entries further left were written by the client and are never trusted.
 * Without trusted proxies (the default) the socket address is used and the header ignored.
 */
import { isIP } from "node:net";

/** Shown when no address could be determined. */
export const UNKNOWN_IP = "unknown";

/**
 * The client IP. `socketAddress` is the TCP peer, `forwardedFor` the `X-Forwarded-For` header
 * (repeated headers joined with commas), `trustProxy` the number of trusted proxy hops (0–5).
 * When the chosen entry is not an IP address (a misconfigured hop count), the socket address is
 * used instead of a value the client may have written.
 */
export function clientIp(
  socketAddress: string | undefined,
  forwardedFor: string | null | undefined,
  trustProxy: number,
): string {
  const peer = normalizeIp(socketAddress) ?? UNKNOWN_IP;
  if (trustProxy <= 0 || forwardedFor === null || forwardedFor === undefined) return peer;
  const entries = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return peer;
  // Fewer entries than hops: the request skipped a proxy; the leftmost entry is the furthest
  // address a trusted proxy recorded.
  const chosen = entries[Math.max(0, entries.length - trustProxy)];
  return normalizeIp(chosen) ?? peer;
}

/**
 * An IP address in canonical form, or `undefined`: strips IPv6 brackets and a `:port` suffix
 * (some proxies add one), unwraps IPv4-mapped IPv6 (`::ffff:192.0.2.1`), lower-cases IPv6.
 */
export function normalizeIp(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed !== null) {
    value = bracketed[1] ?? "";
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(value)) {
    value = value.slice(0, value.lastIndexOf(":"));
  }
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return undefined;
  const lower = value.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  return mapped?.[1] ?? lower;
}

/**
 * The rate-limit key of an IP: IPv4 as is, IPv6 by its /64 prefix (one subscriber usually holds a
 * whole /64, so per-address buckets would be trivial to sidestep).
 */
export function rateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = expandIpv6(ip);
  return groups === undefined ? ip : `${groups.slice(0, 4).join(":")}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (hex, no leading zeros). */
function expandIpv6(ip: string): string[] | undefined {
  let address = ip.toLowerCase();
  // An embedded IPv4 tail (`64:ff9b::192.0.2.1`) becomes two hex groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4 !== null) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    address = `${address.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = address.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  return [...left, ...Array<string>(missing).fill("0"), ...right].map((group) =>
    Number.parseInt(group, 16).toString(16),
  );
}

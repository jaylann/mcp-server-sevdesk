/**
 * Server-side request forgery guard for fetching client metadata documents: the `client_id` URL
 * comes from whoever opens `/authorize`, so the server must not be talked into connecting to its
 * own network. The host is resolved exactly once; every address must be public (globally
 * reachable unicast), and the connection then goes to that checked address (`cimd.ts` pins it),
 * so DNS rebinding between the check and the connect is not possible.
 *
 * Refused: the IPv4 special-purpose ranges (this network, private, CGNAT, loopback, link-local,
 * IETF protocol assignments, documentation, benchmarking, 6to4 relay, multicast, reserved,
 * broadcast) and every IPv6 address outside global unicast `2000::/3` plus its special ranges
 * (IETF protocol assignments including Teredo, documentation). IPv4 addresses embedded in IPv6
 * (v4-mapped, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are unwrapped and checked as IPv4; the
 * deprecated v4-compatible form and local-use NAT64 are refused.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** One address of a resolved host. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Resolves a host name to all its addresses (A and AAAA). Injectable for tests. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The system resolver (`getaddrinfo`, as connections would use it). */
export const systemResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, order: "verbatim" });
  return results.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
};

const V4_BLOCKED: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Special ranges inside global unicast `2000::/3` (everything outside it is refused anyway). */
const V6_BLOCKED: readonly (readonly [string, number])[] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["3fff::", 20],
];

const blocked = new BlockList();
for (const [network, prefix] of V4_BLOCKED) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of V6_BLOCKED) blocked.addSubnet(network, prefix, "ipv6");

/** Whether `address` (an IPv4 or IPv6 literal) is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6 || address.includes("%")) return false;
  const bytes = parseIPv6(address);
  if (bytes === undefined) return false;
  const embedded = embeddedIPv4(bytes);
  if (embedded === false) return false;
  if (embedded !== undefined) return isPublicAddress(embedded);
  // Global unicast is 2000::/3: the first three bits are 001.
  if (((bytes[0] ?? 0) & 0xe0) !== 0x20) return false;
  return !blocked.check(address, "ipv6");
}

/** Why a host was refused. */
export class SsrfError extends Error {
  readonly reason: "unresolvable" | "blocked_address";

  constructor(reason: SsrfError["reason"], message: string) {
    super(message);
    this.name = "SsrfError";
    this.reason = reason;
  }
}

/**
 * Resolves `hostname` once with `resolve` and returns the address to connect to: the first IPv4
 * address if there is one (containers often have no IPv6 route), else the first IPv6 address.
 * Rejects with {@link SsrfError} when it has no address or any of its addresses is not public (a
 * host that answers with one private address is refused as a whole).
 */
export async function resolvePublicAddress(
  hostname: string,
  resolve: Resolver,
): Promise<ResolvedAddress> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new SsrfError("unresolvable", "The client's host name could not be resolved.");
  }
  const [first] = addresses;
  if (first === undefined) {
    throw new SsrfError("unresolvable", "The client's host name has no address.");
  }
  if (!addresses.every((entry) => isPublicAddress(entry.address))) {
    throw new SsrfError(
      "blocked_address",
      "The client's host name resolves to a non-public address.",
    );
  }
  return addresses.find((entry) => entry.family === 4) ?? first;
}

/** The 16 bytes of an IPv6 literal (already validated by `isIP`), or `undefined`. */
function parseIPv6(text: string): Uint8Array | undefined {
  let rest = text;
  const tail: number[] = [];
  const lastColon = rest.lastIndexOf(":");
  const last = rest.slice(lastColon + 1);
  if (last.includes(".")) {
    if (isIP(last) !== 4) return undefined;
    tail.push(...last.split(".").map(Number));
    rest = rest.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`; `a::1.2.3.4` leaves `a::`; `a:b:…:1.2.3.4` leaves `…:`.
    if (rest.endsWith(":") && !rest.endsWith("::")) rest = rest.slice(0, -1);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const groupsOf = (part: string | undefined): string[] =>
    part === undefined || part === "" ? [] : part.split(":");
  const head = groupsOf(halves[0]);
  const back = groupsOf(halves[1]);
  const total = 8 - tail.length / 2;
  const missing = total - head.length - back.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 1 ? 0 : missing).fill("0"), ...back];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  });
  tail.forEach((value, index) => {
    bytes[12 + index] = value;
  });
  return bytes;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function v4(bytes: Uint8Array, offset: number): string {
  return Array.from(bytes.subarray(offset, offset + 4)).join(".");
}

/**
 * The IPv4 address embedded in an IPv6 address that carries one (v4-mapped, NAT64, 6to4),
 * `false` for forms that must not be connected to at all (v4-compatible, local-use NAT64), or
 * `undefined` for ordinary IPv6.
 */
function embeddedIPv4(bytes: Uint8Array): string | false | undefined {
  const zeros10 = Array<number>(10).fill(0);
  if (startsWith(bytes, [...zeros10, 0xff, 0xff])) return v4(bytes, 12);
  if (startsWith(bytes, [...zeros10, 0, 0])) return false;
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return v4(bytes, 12);
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return false;
  if (startsWith(bytes, [0x20, 0x02])) return v4(bytes, 2);
  return undefined;
}

/**
 * The address the dashboard listens on (`dashboard.listen` in the machine
 * file): an IP literal, with an optional port, inside the private or
 * loopback ranges, so serving the dashboard opens no route into the host
 * beyond the network the host already trusts. A host name is refused,
 * since what it resolves to cannot be held to a range.
 */
import { isIP } from "node:net";

/** An address the dashboard may not listen on, with the reason. */
class ListenError extends Error {
  override name = "ListenError";
}

export interface Listen {
  host: string;
  /** `null` when the address names no port. */
  port: number | null;
}

/** IPv4 ranges a dashboard may listen in: loopback, the private ranges, and the shared address space that private overlays (Tailscale among them) hand out. */
const V4_RANGES: ReadonlyArray<[string, number]> = [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
];

function v4(address: string): number {
  return address.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function inV4(address: string): boolean {
  const value = v4(address);
  return V4_RANGES.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return Math.floor(value / size) === Math.floor(v4(base) / size);
  });
}

/** IPv6: loopback, unique local (`fc00::/7`) and link local (`fe80::/10`). */
function inV6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped !== null) return inV4(mapped[1] as string);
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/** Whether an IP literal lies in a range the dashboard may listen in. */
function isPrivateAddress(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return inV4(host);
  if (kind === 6) return inV6(host);
  return false;
}

/** Whether a parsed address is on this machine alone: a request from elsewhere can only arrive through a front the host runs. */
export function isLoopback(listen: Listen): boolean {
  const kind = isIP(listen.host);
  if (kind === 4) return listen.host.startsWith("127.");
  const lower = listen.host.toLowerCase();
  return lower === "::1" || /^::ffff:127(\.\d+){3}$/.test(lower);
}

/** The host name of a `Host` header (`name`, `name:port`, `[v6]:port`), lower-cased; `null` when it is empty. */
export function authorityHost(authority: string | null): string | null {
  const raw = (authority ?? "").trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
  const host = bracketed?.[1] ?? raw.replace(/:\d+$/, "");
  return host === "" ? null : host;
}

/** Whether a `Host` header names this machine's loopback, or one of the front host names the machine file lists. */
export function authorityAllowed(
  authority: string | null,
  fronts: readonly string[],
): boolean {
  const host = authorityHost(authority);
  if (host === null) return false;
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return host.startsWith("127.");
  return fronts.includes(host);
}

/** `host`, `host:port` or `[v6]:port`, held to the private and loopback ranges; throws with the reason. */
export function parseListen(value: string): Listen {
  const raw = value.trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
  const plain = /^([^:]+)(?::(\d+))?$/.exec(raw);
  const match = bracketed ?? (isIP(raw) === 6 ? [raw, raw, undefined] : plain);
  if (match === null)
    throw new ListenError(`${value} is not an address with an optional port`);
  const host = match[1] as string;
  const port = match[2] === undefined ? null : Number(match[2]);
  if (isIP(host) === 0)
    throw new ListenError(
      `${value} names no IP address: the dashboard listens on an address it can hold to the private ranges`,
    );
  if (!isPrivateAddress(host))
    throw new ListenError(
      `${host} is outside the private and loopback ranges, and the dashboard opens no route into the host beyond them`,
    );
  if (
    port !== null &&
    (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  )
    throw new ListenError(`${value} names no port between 1 and 65535`);
  return { host, port };
}

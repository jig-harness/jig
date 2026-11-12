/**
 * The rules a dashboard front's address holds to (`dashboard.front` in the
 * machine's dispatch file): what makes an address one a phone reaches
 * privately and one that carries no token, and how a refusal shows it.
 */
import { isIP } from "node:net";
import { isLoopback, isPrivateAddress } from "./listen.ts";

/** Host names that always mean this machine, so a phone never reaches the host through them. */
const LOOPBACK_NAMES =
  /(^|\.)localhost\.?$|^localhost\.localdomain\.?$|^ip6-(localhost|loopback)\.?$/;

/** Whether a front's host can be reached from a phone: a name other than this machine's own, or a private address other than loopback and link-local (`fe80::/10`). */
function reachableFront(host: string): boolean {
  if (isIP(host) === 0) return !LOOPBACK_NAMES.test(host);
  const linkLocal = isIP(host) === 6 && /^fe[89ab]/i.test(host);
  return (
    isPrivateAddress(host) && !linkLocal && !isLoopback({ host, port: null })
  );
}

/** A path that spells a query or a fragment escaped, or a parameter (`;`), which could carry a token. */
const PATH_TOKEN = /%3f|%23|%3b|;/i;

/** What a front's address must hold to, each with why an address that does not is refused. */
export const FRONT_RULES: ReadonlyArray<
  [(url: URL, raw: string) => boolean, string]
> = [
  [
    (url) => url.protocol === "https:",
    "is not an https: address: a front gives the phone an encrypted page",
  ],
  [
    (url) => url.username === "" && url.password === "",
    "carries a user name or password, which the address must not hold",
  ],
  [
    (url, raw) => url.search === "" && !raw.includes("?"),
    "carries a query, which the address must not hold",
  ],
  [
    (url, raw) => url.hash === "" && !raw.includes("#"),
    "carries a fragment, which the address must not hold",
  ],
  [
    (url) => !PATH_TOKEN.test(url.pathname),
    "has an escaped ? or #, or a ;, in its path, which could carry a token",
  ],
  [
    (url) => reachableFront(url.hostname.replace(/^\[(.*)\]$/, "$1")),
    "names no host a phone reaches privately: a front's address is a name, or an address in the private ranges dashboard.listen accepts, other than loopback and link-local",
  ],
];

/**
 * A front's address as a refusal may show it: scheme, host and path, the path
 * only when it cannot carry a token, and never the user name, password, query
 * or fragment, which a reason would otherwise copy into logs and terminals.
 */
export function shownFront(url: URL): string {
  const pathShown = !PATH_TOKEN.test(url.pathname);
  const withheld =
    !pathShown ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "";
  const shown = `${url.protocol}//${url.host}${pathShown ? url.pathname : "/"}`;
  return withheld ? `${shown} (the rest of it withheld)` : shown;
}

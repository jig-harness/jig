/**
 * The machine file's `dashboard` keys beside `listen` and `require_token`
 * (`machine-config.ts`): the host names a tokenless front forwards under,
 * the front's own address, and the private Unix socket the dashboard also
 * listens on.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import { FRONT_RULES, shownFront } from "./dashboard-front.ts";
import { type Listen, socketPathProblem } from "./listen.ts";
import { type Checked, each, invalid, text } from "./machine-values.ts";

/** The front host names a tokenless dashboard also answers to. */
export function dashboardAllowedHosts(value: unknown): Checked<string[]> {
  const listed = isMapping(value) ? value.allowed_hosts : undefined;
  if (listed === undefined || listed === null) return ok([]);
  if (!Array.isArray(listed))
    return invalid("dashboard.allowed_hosts must be a list");
  const names = each(listed, (name, i) =>
    text(name, `dashboard.allowed_hosts[${i}]`),
  );
  if (!names.ok) return names;
  return ok(names.value.map((name) => name.toLowerCase()));
}

/**
 * The address a front publishes for a phone to open: an absolute `https:`
 * URL with no user name, password, query or fragment, and no escaped query
 * or parameter in its path, whose host is a name or a private address other
 * than loopback and link-local. It is printed in URL-canonical form, so it must not
 * carry a token anywhere. A name is taken as written: Jig never resolves it,
 * nor infers how far it reaches. Only a tokenless dashboard has a front to
 * name.
 */
export function dashboardFront(
  value: unknown,
  requireToken: boolean,
  hasSocket = false,
): Checked<string | null> {
  const given = isMapping(value) ? value.front : undefined;
  if (given === undefined || given === null) return ok(null);
  const address = text(given, "dashboard.front");
  if (!address.ok) return address;
  if (!URL.canParse(address.value))
    return invalid(
      "dashboard.front is not an absolute URL (its value is withheld, since it may hold a credential)",
    );
  const url = new URL(address.value);
  const refuse = (why: string) =>
    invalid(`dashboard.front: ${shownFront(url)} ${why}`);
  const broken = FRONT_RULES.find(([holds]) => !holds(url, address.value));
  if (broken !== undefined) return refuse(broken[1]);
  // The private socket answers without the token, so a front that targets it
  // may sit beside a dashboard whose loopback port still asks for one.
  if (requireToken && !hasSocket)
    return refuse(
      "needs dashboard.require_token: false (or dashboard.socket, which a front targets without a token), since a front's address carries no token and only a listener that asks for none answers it",
    );
  return ok(url.href);
}

/**
 * The private Unix socket the dashboard also listens on, for a front to
 * target: an absolute path short enough for a socket address, beside a
 * `dashboard.listen`, which the reader is configured and installed by.
 */
export function dashboardSocket(
  value: unknown,
  listen: Listen | null,
): Checked<string | null> {
  const given = isMapping(value) ? value.socket : undefined;
  if (given === undefined || given === null) return ok(null);
  const path = text(given, "dashboard.socket");
  if (!path.ok) return path;
  const problem = socketPathProblem(path.value);
  if (problem !== null) return invalid(`dashboard.socket ${problem}`);
  if (listen === null)
    return invalid(
      "dashboard.socket needs dashboard.listen: the socket is a second listener beside the address",
    );
  return path;
}

/**
 * The machine file's `dashboard` section: the address the dashboard listens
 * on, whether it demands its token, the front host names a tokenless
 * dashboard answers to and the address a front publishes.
 */
import { isMapping } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import { FRONT_RULES, shownFront } from "./dashboard-front.ts";
import { isLoopback, type Listen, parseListen } from "./listen.ts";
import {
  type Checked,
  each,
  flag,
  invalid,
  only,
  text,
} from "./machine-values.ts";

const DASHBOARD_KEYS = ["listen", "require_token", "allowed_hosts", "front"];

/** The dashboard's address; `null` when the file names none. */
export function dashboard(value: unknown): Checked<Listen | null> {
  if (value === undefined || value === null) return ok(null);
  if (!isMapping(value)) return invalid("dashboard must be a mapping");
  const known = only(value, DASHBOARD_KEYS, "dashboard");
  if (!known.ok) return known;
  if (value.listen === undefined || value.listen === null) return ok(null);
  const address = text(value.listen, "dashboard.listen");
  if (!address.ok) return address;
  const listen = parseListen(address.value);
  return listen.ok
    ? listen
    : invalid(`dashboard.listen: ${listen.failure.reason}`);
}

/** Whether the dashboard demands its token. Turning it off is accepted only where nothing but a front on this host can reach the port. */
export function dashboardRequireToken(value: unknown): Checked<boolean> {
  const listen = dashboard(value);
  if (!listen.ok) return listen;
  const required = flag(
    isMapping(value) ? value.require_token : undefined,
    "dashboard.require_token",
    true,
  );
  if (!required.ok) return required;
  if (!required.value && (listen.value === null || !isLoopback(listen.value)))
    return invalid(
      "dashboard.require_token: false needs a loopback dashboard.listen (127.0.0.1 or ::1), since only a front on this host that authenticates the person may reach a page with no token",
    );
  return required;
}

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
  if (requireToken)
    return refuse(
      "needs dashboard.require_token: false, since a front's address carries no token and only a dashboard that asks for none answers it",
    );
  return ok(url.href);
}

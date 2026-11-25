/**
 * The hub's settings file: one schema, checked when it loads
 * ([design/control-plane.md § Apart from the sessions on a shared machine](../../../design/control-plane.md#apart-from-the-sessions-on-a-shared-machine)).
 *
 * The file holds what the process adapter needs to run: the OS user it
 * runs as, its database directory and the three listeners' addresses. The
 * secrets later steps add (the forge App's key, the webhook secrets, the
 * identity key) join this same file, so it is readable by the hub's user
 * alone: loading refuses a file another user can read or that another
 * user owns, and a database directory that is not the hub user's alone.
 *
 * ```yaml
 * user: jig-hub                       # the OS user the hub runs as
 * database: ~/.jig/hub/data           # mode 0700
 * host:
 *   listen: [127.0.0.1:7461, 100.101.102.103:7461]
 * webhooks:
 *   listen: 127.0.0.1:7462            # where the tunnel forwards /webhooks/
 * feed:
 *   socket: ~/.jig/hub-feed/feed.sock # or listen: 127.0.0.1:7463 with secret
 *   group: jig-front
 * ```
 *
 * `/v1/` and the webhook listener take loopback or private-network
 * addresses only (`127/8`, `10/8`, `172.16/12`, `192.168/16`, the shared
 * `100.64/10` a private overlay hands out, `::1`, `fc00::/7`), never every
 * interface (`0.0.0.0`, `::`), a link-local address (`fe80::/10`, which
 * names no private network, only the link) or a public address. A feed on
 * a port takes loopback only, with the secret the front adds to every
 * request. The feed's default socket sits outside the hub's own directory,
 * which stays the hub user's alone, so the front's group can be let
 * through to it (`host-paths.ts`).
 */
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";
import { isMapping, jigHome } from "../../shared/config-layers.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { load } from "../../shared/yaml.ts";
import { isLoopback, isPrivateAddress } from "../../dispatch/lib/listen.ts";

/** An address a listener binds: an IP literal and a port (0 for any free one). */
export interface ListenAddress {
  readonly host: string;
  readonly port: number;
}

/** Where the feed listens: a Unix socket, or loopback with the front's secret. */
export type FeedListen =
  | { readonly socket: string; readonly group: string | null }
  | { readonly listen: ListenAddress; readonly secret: string };

export interface HubSettings {
  /** The settings file itself. */
  readonly path: string;
  /** The OS user the hub runs as. */
  readonly user: string;
  /** The database directory, mode 0700. */
  readonly database: string;
  /** Where `/v1/` listens: loopback and private-network addresses only. */
  readonly host: readonly ListenAddress[];
  /** Where the webhook listener listens. */
  readonly webhooks: ListenAddress;
  readonly feed: FeedListen;
}

export type SettingsFailureCode = "unreadable" | "invalid" | "exposed";

/** The hub's OS user when the settings name none. */
const DEFAULT_HUB_USER = "jig-hub";
/** The default ports of the host and webhook listeners. */
const DEFAULT_HOST_PORT = 7461;
const DEFAULT_WEBHOOK_PORT = 7462;
/** The fewest characters a feed secret has. */
const MIN_SECRET_LENGTH = 32;

/** The hub's own directory under the Jig home: `~/.jig/hub`. */
export function hubHome(env: Record<string, string | undefined> = process.env) {
  return join(jigHome(env), "hub");
}

/** The feed's socket when the settings name none: beside the hub's own directory, not in it. */
export function defaultFeedSocket(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(jigHome(env), "hub-feed", "feed.sock");
}

/** The settings file when `--settings` names none. */
export function defaultSettingsPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(hubHome(env), "settings.yaml");
}

/** Who the process runs as. */
export interface Identity {
  readonly uid: number;
  readonly user: string;
}

type Checked<T> = Outcome<T, "invalid">;

const invalid = (path: string, reason: string) =>
  failed("invalid", `${path}: ${reason}`);

/** A path: `~/` expanded, a relative one read against the settings file's directory. */
function pathValue(
  value: unknown,
  field: string,
  file: string,
): Checked<string> {
  if (typeof value !== "string" || value.trim() === "")
    return invalid(file, `${field} must be a path`);
  const expanded = value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;
  return ok(isAbsolute(expanded) ? expanded : resolve(dirname(file), expanded));
}

/** `host:port` or `[v6]:port`, the host an IP literal. */
export function parseAddress(
  value: unknown,
): Outcome<ListenAddress, "invalid"> {
  if (typeof value !== "string")
    return failed("invalid", "an address is host:port");
  const raw = value.trim();
  const match =
    /^\[([^\]]+)\]:(\d+)$/.exec(raw) ?? /^([^:[\]]+):(\d+)$/.exec(raw);
  if (match === null)
    return failed("invalid", `${raw} is not host:port ([v6]:port for IPv6)`);
  const host = match[1] as string;
  const port = Number(match[2]);
  if (isIP(host) === 0) return failed("invalid", `${raw} names no IP address`);
  if (!Number.isSafeInteger(port) || port > 65_535)
    return failed("invalid", `${raw} names no port between 0 and 65535`);
  return ok({ host, port });
}

/** Whether `/v1/` and the webhook listener may bind `address`: loopback or a private network, never every interface or a link-local address. */
export function privateAddress(address: ListenAddress): boolean {
  const linkLocal = isIP(address.host) === 6 && /^fe[89ab]/i.test(address.host);
  return !linkLocal && isPrivateAddress(address.host);
}

/** An address a listener may bind, or why not. */
function boundedAddress(
  value: unknown,
  field: string,
  file: string,
  loopbackOnly: boolean,
): Checked<ListenAddress> {
  const parsed = parseAddress(value);
  if (!parsed.ok) return invalid(file, `${field}: ${parsed.failure.reason}`);
  const address = parsed.value;
  if (loopbackOnly && !isLoopback({ host: address.host, port: address.port }))
    return invalid(
      file,
      `${field}: ${address.host} is not loopback; a feed on a port listens on loopback only`,
    );
  if (!privateAddress(address))
    return invalid(
      file,
      `${field}: ${address.host} is neither loopback nor a private network's address; the hub never listens on every interface or a public address`,
    );
  return ok(address);
}

/** A mapping's keys outside `known`, refused so a misspelled setting is not ignored. */
function unknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  where: string,
  file: string,
): Checked<null> {
  const extra = Object.keys(value).filter((key) => !known.includes(key));
  return extra.length === 0
    ? ok(null)
    : invalid(file, `${where} has no setting ${extra.join(", ")}`);
}

/** A section that may be absent: its mapping, empty when absent. */
function section(
  values: Record<string, unknown>,
  key: string,
  known: readonly string[],
  file: string,
): Checked<Record<string, unknown>> {
  const value = values[key];
  if (value === undefined || value === null) return ok({});
  if (!isMapping(value)) return invalid(file, `${key} must be a mapping`);
  const extra = unknownKeys(value, known, key, file);
  return extra.ok ? ok(value) : extra;
}

function hostAddresses(
  values: Record<string, unknown>,
  file: string,
): Checked<ListenAddress[]> {
  const host = section(values, "host", ["listen"], file);
  if (!host.ok) return host;
  const listen = host.value.listen ?? [`127.0.0.1:${DEFAULT_HOST_PORT}`];
  const list = Array.isArray(listen) ? listen : [listen];
  if (list.length === 0) return invalid(file, "host.listen names no address");
  const addresses: ListenAddress[] = [];
  for (const [index, entry] of list.entries()) {
    const address = boundedAddress(entry, `host.listen[${index}]`, file, false);
    if (!address.ok) return address;
    addresses.push(address.value);
  }
  return ok(addresses);
}

function webhookAddress(
  values: Record<string, unknown>,
  file: string,
): Checked<ListenAddress> {
  const webhooks = section(values, "webhooks", ["listen"], file);
  if (!webhooks.ok) return webhooks;
  return boundedAddress(
    webhooks.value.listen ?? `127.0.0.1:${DEFAULT_WEBHOOK_PORT}`,
    "webhooks.listen",
    file,
    false,
  );
}

/** A feed on loopback, with the secret the front adds. */
function portFeed(
  feed: Record<string, unknown>,
  file: string,
): Checked<FeedListen> {
  if (feed.socket !== undefined || feed.group !== undefined)
    return invalid(
      file,
      "feed takes socket (with group) or listen (with secret), not both",
    );
  const address = boundedAddress(feed.listen, "feed.listen", file, true);
  if (!address.ok) return address;
  const { secret } = feed;
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH)
    return invalid(
      file,
      `feed.listen needs feed.secret, the secret the front adds, of at least ${MIN_SECRET_LENGTH} characters`,
    );
  return ok({ listen: address.value, secret });
}

/** A feed on a Unix socket, opened to the front's group when one is named. */
function socketFeed(
  feed: Record<string, unknown>,
  file: string,
  env: Record<string, string | undefined>,
): Checked<FeedListen> {
  if (feed.secret !== undefined)
    return invalid(
      file,
      "feed.secret goes with feed.listen; a socket's file mode guards it instead",
    );
  const group = feed.group ?? null;
  if (group !== null && !isName(group))
    return invalid(file, "feed.group must be a group's name");
  const path = pathValue(
    feed.socket ?? defaultFeedSocket(env),
    "feed.socket",
    file,
  );
  return path.ok ? ok({ socket: path.value, group }) : path;
}

/** Whether `value` is a user's or a group's name. */
function isName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z_][a-z0-9_-]*\$?$/i.test(value);
}

function feedListen(
  values: Record<string, unknown>,
  file: string,
  env: Record<string, string | undefined>,
): Checked<FeedListen> {
  const feed = section(
    values,
    "feed",
    ["socket", "group", "listen", "secret"],
    file,
  );
  if (!feed.ok) return feed;
  return feed.value.listen === undefined
    ? socketFeed(feed.value, file, env)
    : portFeed(feed.value, file);
}

/** The settings in `text`, as the file at `file` holds them. */
export function parseHubSettings(
  text: string,
  file: string,
  env: Record<string, string | undefined> = process.env,
): Checked<HubSettings> {
  const parsed = attempt("invalid", `${file} does not parse`, () => load(text));
  if (!parsed.ok) return parsed;
  const values = parsed.value ?? {};
  if (!isMapping(values))
    return invalid(file, "the settings must be a mapping");
  const extra = unknownKeys(
    values,
    ["user", "database", "host", "webhooks", "feed"],
    "the settings file",
    file,
  );
  if (!extra.ok) return extra;
  const user = values.user ?? DEFAULT_HUB_USER;
  if (!isName(user)) return invalid(file, "user must be an OS user's name");
  const database = pathValue(
    values.database ?? join(hubHome(env), "data"),
    "database",
    file,
  );
  if (!database.ok) return database;
  const host = hostAddresses(values, file);
  if (!host.ok) return host;
  const webhooks = webhookAddress(values, file);
  if (!webhooks.ok) return webhooks;
  const feed = feedListen(values, file, env);
  if (!feed.ok) return feed;
  return ok({
    path: file,
    user,
    database: database.value,
    host: host.value,
    webhooks: webhooks.value,
    feed: feed.value,
  });
}

/** What a file's mode and owner say about who else can read it. */
export function exposure(
  stats: Pick<Stats, "mode" | "uid">,
  identity: Pick<Identity, "uid">,
  allowed: number,
): string | null {
  if (stats.uid !== identity.uid)
    return `it is owned by uid ${stats.uid}, not the hub's user (uid ${identity.uid})`;
  const mode = stats.mode & 0o777;
  if ((mode & ~allowed) !== 0)
    return `its mode is ${mode.toString(8).padStart(4, "0")}, readable beyond the hub's user; it must be ${allowed.toString(8).padStart(4, "0")}`;
  return null;
}

/** Reads a file's mode and owner without following a link. */
export type StatReader = (
  path: string,
) => Pick<Stats, "mode" | "uid" | "gid" | "isDirectory">;

const lstat: StatReader = (path) => lstatSync(path);

/**
 * The settings file at `file` is the hub user's alone (mode 0600) and the
 * database directory it names is too (mode 0700): `exposed` when not.
 */
export function checkPrivate(
  settings: Pick<HubSettings, "path" | "database">,
  identity: Pick<Identity, "uid">,
  stat: StatReader = lstat,
): Outcome<null, "unreadable" | "exposed"> {
  const file = attempt("unreadable", `cannot read ${settings.path}`, () =>
    stat(settings.path),
  );
  if (!file.ok) return file;
  const fileExposed = exposure(file.value, identity, 0o600);
  if (fileExposed !== null)
    return failed(
      "exposed",
      `the settings file ${settings.path}: ${fileExposed}`,
    );
  const directory = attempt(
    "unreadable",
    `cannot read the database directory ${settings.database}`,
    () => stat(settings.database),
  );
  if (!directory.ok) return directory;
  if (!directory.value.isDirectory())
    return failed("unreadable", `${settings.database} is not a directory`);
  const directoryExposed = exposure(directory.value, identity, 0o700);
  return directoryExposed === null
    ? ok(null)
    : failed(
        "exposed",
        `the database directory ${settings.database}: ${directoryExposed}`,
      );
}

/** Reads and parses the settings file, without checking its mode. */
export function readHubSettings(
  file: string,
  env: Record<string, string | undefined> = process.env,
): Outcome<HubSettings, SettingsFailureCode> {
  const text = attempt(
    "unreadable",
    `cannot read the hub's settings ${file}`,
    () => readFileSync(file, "utf8"),
  );
  if (!text.ok) return text;
  return parseHubSettings(text.value, file, env);
}

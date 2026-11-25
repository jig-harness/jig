/**
 * `jig doctor hub`'s checks: the OS user the hub runs as, the modes of its
 * settings file and database directory, the interfaces its listeners bind,
 * and the container tool. Each is skipped on a machine with no hub
 * settings, so a bare `jig doctor` passes where no hub is set up. Later
 * steps add their own checks beside these.
 */
import { lstatSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import type { DoctorCheck } from "../../runtime/component.ts";
import { errnoCode } from "../../shared/errors.ts";
import { attempt, ok, type Outcome } from "../../shared/outcome.ts";
import { containerRuntime, type ContainerRuntime } from "./container.ts";
import { feedDirectoryMode, feedPathBlocks, groupId } from "./host-paths.ts";
import { readServeRecord } from "./serve.ts";
import {
  defaultSettingsPath,
  exposure,
  type HubSettings,
  type Identity,
  parseAddress,
  privateAddress,
  readHubSettings,
  type StatReader,
} from "./settings.ts";

export interface DoctorProbes {
  readonly identity: Identity;
  readonly settingsPath: string;
  readonly stat: StatReader;
  /** Why this user is the dispatcher's, or null; `unreadable` when it cannot be told. */
  dispatcherHere(): Promise<Outcome<string | null, "unreadable">>;
  runtime(): ContainerRuntime | null;
}

const check = (
  id: string,
  status: DoctorCheck["status"],
  detail: string,
  fix?: string,
): DoctorCheck => ({ id, status, detail, ...(fix ? { fix } : {}) });

/** The mode check of one private path. */
function modeCheck(
  id: string,
  what: string,
  path: string,
  allowed: number,
  probes: DoctorProbes,
): DoctorCheck {
  const stats = attempt("unreadable", `cannot read ${what} ${path}`, () =>
    probes.stat(path),
  );
  if (!stats.ok)
    return errnoCode(stats.failure.cause) === "ENOENT"
      ? check(id, "skip", `no ${what} ${path} yet`)
      : check(id, "fail", stats.failure.reason);
  const exposed = exposure(stats.value, probes.identity, allowed);
  return exposed === null
    ? check(id, "pass", `${what} ${path} is the hub user's alone`)
    : check(
        id,
        "fail",
        `${what} ${path}: ${exposed}`,
        `chown ${probes.identity.user} ${path} && chmod ${allowed.toString(8)} ${path}`,
      );
}

/** The interfaces the settings name and the running hub recorded. */
function interfacesCheck(settings: HubSettings): DoctorCheck {
  const id = "hub:interfaces";
  const recorded = readServeRecord(settings.database);
  const bound = (recorded?.listeners ?? [])
    .filter((listener) => listener.address.startsWith("http://"))
    .map((listener) => {
      const address = parseAddress(listener.address.slice("http://".length));
      return { name: listener.name, address };
    });
  const named = [...settings.host, settings.webhooks];
  const outside = [
    ...named.filter((address) => !privateAddress(address)).map((a) => a.host),
    ...bound
      .filter((b) => !b.address.ok || !privateAddress(b.address.value))
      .map((b) => b.name),
  ];
  if (outside.length > 0)
    return check(
      id,
      "fail",
      `a listener is bound beyond loopback and the private network: ${outside.join(", ")}`,
      `set host.listen and webhooks.listen in ${settings.path} to loopback or private-network addresses`,
    );
  const where = settings.host.map((a) => `${a.host}:${a.port}`).join(", ");
  return check(
    id,
    "pass",
    `/v1/ on ${where}; webhooks on ${settings.webhooks.host}:${settings.webhooks.port}${recorded === null ? "; the hub is not running" : "; the running hub bound the same"}`,
  );
}

const FEED_CHECK = "hub:feed";
const REMAKE_FEED = "run jig install hub --yes again, which makes it";

/** The feed socket's directory as it stands: its owner, mode and group, then whether the front's group reaches it. */
function socketDirectoryCheck(
  feed: { readonly socket: string; readonly group: string | null },
  stats: Pick<Stats, "mode" | "uid" | "gid">,
  uid: number,
): DoctorCheck {
  const directory = dirname(feed.socket);
  const wanted = feedDirectoryMode(feed.group);
  const gid = feed.group === null ? ok(null) : groupId(feed.group);
  if (!gid.ok)
    return check(
      FEED_CHECK,
      "fail",
      gid.failure.reason,
      "create the front's group, or remove feed.group",
    );
  const owned = stats.uid === uid && (stats.mode & 0o777) === wanted;
  if (!owned || (gid.value !== null && stats.gid !== gid.value))
    return check(
      FEED_CHECK,
      "fail",
      `the feed socket directory ${directory} is not the hub user's with mode ${wanted.toString(8).padStart(4, "0")}${feed.group === null ? "" : ` and the group ${feed.group}`}`,
      REMAKE_FEED,
    );
  if (gid.value === null)
    return check(
      FEED_CHECK,
      "pass",
      `the feed socket ${feed.socket} is the hub user's alone`,
    );
  const blocks = feedPathBlocks(feed.socket, gid.value);
  return blocks.length === 0
    ? check(
        FEED_CHECK,
        "pass",
        `the front's group ${feed.group} reaches the feed socket ${feed.socket}`,
      )
    : check(
        FEED_CHECK,
        "warn",
        `the front's group ${feed.group} cannot pass ${blocks.join(", ")} on the way to the feed socket`,
        "give each the others' search permission (chmod o+x), or set feed.socket under a directory it can pass",
      );
}

/** The feed socket's directory: the hub user's, mode 0700, or 0710 and the front's group, which can reach it. */
function feedCheck(settings: HubSettings, probes: DoctorProbes): DoctorCheck {
  const { feed } = settings;
  if (!("socket" in feed))
    return check(
      FEED_CHECK,
      "pass",
      `the feed listens on ${feed.listen.host}:${feed.listen.port} with the front's secret`,
    );
  const directory = dirname(feed.socket);
  const stats = attempt("unreadable", `cannot read ${directory}`, () =>
    probes.stat(directory),
  );
  if (!stats.ok)
    return check(
      FEED_CHECK,
      "warn",
      errnoCode(stats.failure.cause) === "ENOENT"
        ? `no feed socket directory ${directory} yet`
        : stats.failure.reason,
      REMAKE_FEED,
    );
  return socketDirectoryCheck(feed, stats.value, probes.identity.uid);
}

/** Every check of `jig doctor hub`. */
export async function hubDoctorChecks(
  probes: DoctorProbes,
): Promise<DoctorCheck[]> {
  const present = attempt("unreadable", "", () =>
    probes.stat(probes.settingsPath),
  );
  if (!present.ok && errnoCode(present.failure.cause) === "ENOENT")
    return [
      check(
        "hub:settings",
        "skip",
        `no hub settings at ${probes.settingsPath}: no hub runs as this user`,
      ),
    ];
  const read = readHubSettings(probes.settingsPath);
  if (!read.ok)
    return [
      check(
        "hub:settings",
        "fail",
        read.failure.reason,
        "fix the settings file (plugin/hub/README.md lists its settings)",
      ),
    ];
  const settings = read.value;
  const dispatcher = await probes.dispatcherHere();
  const userProblem =
    probes.identity.uid === 0
      ? "the hub runs as root"
      : probes.identity.user !== settings.user
        ? `this is ${probes.identity.user}, not the hub's user ${settings.user}`
        : dispatcher.ok
          ? dispatcher.value
          : dispatcher.failure.reason;
  const runtime = probes.runtime();
  return [
    userProblem === null
      ? check("hub:user", "pass", `the hub runs as ${settings.user}`)
      : check(
          "hub:user",
          "fail",
          userProblem,
          `run the hub under an OS user of its own (${settings.user}), never root or the dispatcher's user`,
        ),
    modeCheck(
      "hub:settings-mode",
      "the settings file",
      settings.path,
      0o600,
      probes,
    ),
    modeCheck(
      "hub:database-mode",
      "the database directory",
      settings.database,
      0o700,
      probes,
    ),
    interfacesCheck(settings),
    feedCheck(settings, probes),
    runtime === null
      ? check(
          "hub:container",
          "warn",
          "no podman or docker: the hub runs as a process, apart from sessions by its OS user and file modes only",
          "install podman (rootless) or docker, then run jig install hub --yes again",
        )
      : check("hub:container", "pass", `the hub's image runs on ${runtime}`),
  ];
}

/** The probes on this machine. */
export function systemDoctorProbes(
  identity: Identity,
  dispatcherHere: DoctorProbes["dispatcherHere"],
): DoctorProbes {
  return {
    identity,
    settingsPath: defaultSettingsPath(),
    stat: (path) => lstatSync(path),
    dispatcherHere,
    runtime: () => containerRuntime(),
  };
}

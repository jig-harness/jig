/**
 * The directories the hub needs on the host before it starts, made by the
 * host side (`jig install hub` and `jig hub serve --scheduled`) rather than
 * the hub itself, so they exist, with the right owner and mode, before a
 * container mounts them: a container tool refuses, or makes root-owned, a
 * mount whose directory is missing.
 *
 * The database directory is made mode 0700. The feed socket's directory is
 * what guards the socket: mode 0700 with no `feed.group`, and with one,
 * mode 0710 and that group, resolved here on the host where it is known, so
 * the front's group may pass through it to the socket and list nothing.
 * The hub makes the socket itself open to whoever reaches it
 * (`listeners.ts`), and never needs the group's name or id, which a
 * container's own group database does not hold. Every directory above the
 * socket's must let the front's group pass too; `feedPathBlocks` names the
 * ones that do not.
 */
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { HubSettings } from "./settings.ts";

/** The group id of `name`, from the host's group database. */
export function groupId(
  name: string,
  readGroups: () => string = () => readFileSync("/etc/group", "utf8"),
): Outcome<number, "unavailable"> {
  const text = attempt("unavailable", "cannot read /etc/group", readGroups);
  if (!text.ok) return text;
  for (const line of text.value.split("\n")) {
    const [group, , id] = line.split(":");
    if (group === name && id !== undefined && /^\d+$/.test(id))
      return ok(Number(id));
  }
  return failed("unavailable", `no group named ${name} in /etc/group`);
}

/** The mode the feed socket's directory has: 0710 opened to the front's group, else 0700. */
export function feedDirectoryMode(group: string | null): number {
  return group === null ? 0o700 : 0o710;
}

/**
 * The directories above the socket's that the front's group (`gid`) cannot
 * pass through, each with its mode; empty when every one lets it.
 */
export function feedPathBlocks(socket: string, gid: number): string[] {
  const blocks: string[] = [];
  let path = dirname(dirname(socket));
  for (;;) {
    const stats = attempt("unreadable", "", () => statSync(path));
    const mode = stats.ok ? stats.value.mode & 0o777 : null;
    const passes =
      mode !== null &&
      ((mode & 0o001) !== 0 ||
        ((mode & 0o010) !== 0 && stats.ok && stats.value.gid === gid));
    if (!passes)
      blocks.push(
        `${path} (${mode === null ? "unreadable" : `mode ${mode.toString(8).padStart(4, "0")}`})`,
      );
    const parent = dirname(path);
    if (parent === path) return blocks;
    path = parent;
  }
}

/**
 * Makes the database directory and the feed socket's directory, with their
 * owner and mode: what a front's group cannot pass on the way to the socket,
 * for the caller to warn about; `unavailable` when a directory cannot be
 * made or given its group and mode.
 */
export function prepareHostPaths(
  settings: Pick<HubSettings, "database" | "feed">,
  resolveGroup: (name: string) => Outcome<number, "unavailable"> = groupId,
): Outcome<string[], "unavailable"> {
  const database = attempt(
    "unavailable",
    `cannot make the database directory ${settings.database}`,
    () => mkdirSync(settings.database, { recursive: true, mode: 0o700 }),
  );
  if (!database.ok) return database;
  const { feed } = settings;
  if (!("socket" in feed)) return ok([]);
  const directory = dirname(feed.socket);
  const mode = feedDirectoryMode(feed.group);
  const made = attempt(
    "unavailable",
    `cannot make the feed socket's directory ${directory}`,
    () => mkdirSync(directory, { recursive: true, mode }),
  );
  if (!made.ok) return made;
  const gid = feed.group === null ? ok(null) : resolveGroup(feed.group);
  if (!gid.ok) return gid;
  const opened = attempt(
    "unavailable",
    `cannot give the feed socket's directory ${directory} ${gid.value === null ? "mode 0700" : `the group ${feed.group} and mode 0710`}`,
    () => {
      if (gid.value !== null) chownSync(directory, -1, gid.value);
      chmodSync(directory, mode);
    },
  );
  if (!opened.ok) return opened;
  if (gid.value === null) return ok([]);
  const blocks = feedPathBlocks(feed.socket, gid.value);
  return ok(
    blocks.length === 0
      ? []
      : [
          `the front's group ${feed.group} cannot pass ${blocks.join(", ")} on the way to the feed socket: give each the others' search permission (chmod o+x), or set feed.socket under a directory it can pass`,
        ],
  );
}

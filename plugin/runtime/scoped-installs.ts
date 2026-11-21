/**
 * Claude Code's installs of the plugin made for one directory (project and
 * local scope), beside the user-scope install `harness.ts` upgrades. After
 * that upgrade, each is brought to the user-scope version:
 *
 * - one whose directory no longer exists is dropped from Claude Code's
 *   install record, since no `claude` command can reach it there;
 * - the others are refreshed by `claude plugin update --scope <scope>` run
 *   from their directory, once per repository. Claude Code (2.1.311) updates
 *   the first record whose directory shares the repository's git common
 *   directory, not the worktree it runs in, so in a repository with several
 *   worktrees one update reaches one record whatever directory it runs from;
 * - one that update did not reach, while it refreshed another directory (its
 *   `--json` result names it) or another worktree of the same repository is
 *   at the user-scope version, is refreshed in the install record itself: it
 *   is pointed at the user-scope install's folder and version. A later run
 *   from another configuration directory sharing the record then finds every
 *   install current and runs no update.
 *
 * One that none of these can bring there safely is left as it was, saying
 * why. The record is only read and edited; no directory or worktree is
 * removed.
 */
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { currentIso } from "../shared/time.ts";
import {
  code,
  commandTimeoutMs,
  HarnessError,
  json,
  PLUGIN_ID,
  reason,
  run,
  type Say,
} from "./harness-command.ts";

/** A Claude Code install of the plugin made for one directory. */
export interface ScopedInstall {
  scope: "project" | "local";
  /** The directory it was installed for; it may since have been deleted. */
  project: string;
  version: string;
  enabled: boolean;
}

/** The project- and local-scope installs from `claude plugin list --json`. */
export function claudeScopedInstalls(list: unknown): ScopedInstall[] {
  if (!Array.isArray(list))
    throw new HarnessError(
      "claude plugin list --json did not print a list of plugins",
    );
  return list.flatMap((entry): ScopedInstall[] =>
    entry?.id === PLUGIN_ID &&
    (entry.scope === "project" || entry.scope === "local") &&
    typeof entry.projectPath === "string" &&
    entry.projectPath !== "" &&
    typeof entry.version === "string"
      ? [
          {
            scope: entry.scope,
            project: entry.projectPath,
            version: entry.version,
            enabled: entry.enabled === true,
          },
        ]
      : [],
  );
}

/** The folder of the user-scope install `claude plugin list --json` names, or null. */
function userInstallPath(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (plugin) => plugin?.id === PLUGIN_ID && plugin?.scope === "user",
  );
  const path = entry?.installPath;
  return typeof path === "string" && path !== "" ? path : null;
}

/** Claude Code's project- and local-scope installs of the plugin. */
export function scopedInstalls(program = "claude"): ScopedInstall[] {
  return claudeScopedInstalls(json(program, ["plugin", "list", "--json"]));
}

/**
 * Whether a scoped install's directory is there: `present`, `gone`, or why
 * neither can be said (a file in its place, a directory that cannot be read).
 */
export function directoryState(path: string): "present" | "gone" | string {
  try {
    return statSync(path).isDirectory()
      ? "present"
      : `${path} is not a directory`;
  } catch (error) {
    // ENOTDIR means a parent is a file, which says nothing of this directory.
    if (code(error) === "ENOENT") return "gone";
    return `${path} cannot be read: ${reason(error)}`;
  }
}

/** A directory as one key, whichever link or relative form names it. */
function directoryKey(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The git common directory `dir`'s checkout shares with its other worktrees,
 * or null outside a checkout or when git cannot say. The inherited `GIT_*`
 * variables are dropped, so a hook's `GIT_DIR` does not answer for `dir`.
 */
export function repositoryOf(dir: string): string | null {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: dir,
    env,
    encoding: "utf8",
    timeout: commandTimeoutMs(),
    killSignal: "SIGKILL",
  });
  const out = result.status === 0 ? result.stdout.trim() : "";
  return out === "" ? null : directoryKey(resolve(dir, out));
}

/**
 * The directory a `claude plugin update --json` result says it updated, from
 * its message (`updated from 0.1.0 to 0.2.0 for scope project (<dir>)`), or
 * null when it names none.
 */
export function updatedProject(output: string): string | null {
  const line = output.trim().split("\n").at(-1) ?? "";
  let result: unknown;
  try {
    result = JSON.parse(line);
  } catch {
    return null;
  }
  const message = isRecord(result) ? result.message : undefined;
  if (typeof message !== "string") return null;
  return (
    /for scope (?:project|local) \((.+)\)\.?$/.exec(message.trim())?.[1] ?? null
  );
}

/**
 * Claude Code's record of what it installed, in its plugins directory:
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` where set, else under its configuration directory.
 */
function claudeInstallRecord(env: NodeJS.ProcessEnv = process.env): string {
  return join(
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR ||
      join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins"),
    "installed_plugins.json",
  );
}

/** The form of Claude Code's install record this release can edit. */
const RECORD_VERSION = 2;

/** The record's entries for the plugin, or why this release must not edit it. */
function recordEntries(
  record: string,
): { data: { plugins: Record<string, unknown> }; entries: unknown[] } | string {
  let data: { version?: unknown; plugins?: Record<string, unknown> };
  try {
    data = JSON.parse(readFileSync(record, "utf8"));
  } catch (error) {
    return `${record} cannot be read: ${reason(error)}`;
  }
  const entries = data?.plugins?.[PLUGIN_ID];
  if (data?.version !== RECORD_VERSION || !Array.isArray(entries))
    return `${record} is not in the form this release edits (version ${RECORD_VERSION}, with a ${PLUGIN_ID} list)`;
  return { data: data as { plugins: Record<string, unknown> }, entries };
}

/** The key that names one scoped install in the record and in the list. */
const scopedKey = (scope: unknown, project: unknown) =>
  JSON.stringify([scope, project]);

/** The key of a record entry. */
function entryKey(entry: unknown): string {
  const { scope, projectPath } = (entry ?? {}) as Record<string, unknown>;
  return scopedKey(scope, projectPath);
}

/** An edit of the plugin's record entries: the entries after it, the keys it settled, and whether it changed any. */
type RecordEdit = (entries: unknown[]) => {
  entries: unknown[];
  settled: Set<string>;
  changed: boolean;
};

/**
 * Applies `edit` to Claude Code's install record, replacing the record whole
 * through a file beside it: the keys the edit settled, or why it left the
 * record as it was.
 */
function editRecord(link: string, edit: RecordEdit): Set<string> | string {
  let record: string;
  let before: ReturnType<typeof statSync>;
  try {
    // A record kept as a link is written where the link points.
    record = realpathSync(link);
    before = statSync(record);
  } catch (error) {
    return `${link} cannot be read: ${reason(error)}`;
  }
  const read = recordEntries(record);
  if (typeof read === "string") return read;
  const { entries, settled, changed } = edit(read.entries);
  if (!changed) return settled;
  const { plugins } = read.data;
  if (entries.length === 0) delete plugins[PLUGIN_ID];
  else plugins[PLUGIN_ID] = entries;
  const next = `${record}.jig-${process.pid}`;
  try {
    writeFileSync(next, `${JSON.stringify(read.data, null, 2)}\n`, {
      mode: Number(before.mode) & 0o777,
    });
    // Claude Code writes this record too; one it rewrote meanwhile is left
    // for the next upgrade rather than overwritten. The window that remains,
    // between this check and the rename, can still lose its write.
    const now = statSync(record);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      rmSync(next, { force: true });
      return `${record} changed while it was being edited; the next upgrade tries again`;
    }
    renameSync(next, record);
  } catch (error) {
    rmSync(next, { force: true });
    return `${record} cannot be written: ${reason(error)}`;
  }
  return settled;
}

/** Drops each of `gone` whose directory is still missing. */
function dropGone(gone: readonly ScopedInstall[]): RecordEdit {
  const wanted = new Set(gone.map((i) => scopedKey(i.scope, i.project)));
  return (entries) => {
    const settled = new Set<string>();
    const kept = entries.filter((entry) => {
      const key = entryKey(entry);
      const { projectPath } = (entry ?? {}) as Record<string, unknown>;
      const drop =
        wanted.has(key) && directoryState(String(projectPath)) === "gone";
      if (drop) settled.add(key);
      return !drop;
    });
    return { entries: kept, settled, changed: settled.size > 0 };
  };
}

/**
 * Points each of `stale` at the user-scope install's folder and `version`,
 * as `claude plugin update` would have, taking the commit the record names
 * for the user-scope install when that is at `version`.
 */
function pointAtUserInstall(
  stale: readonly ScopedInstall[],
  version: string,
  installPath: string,
): RecordEdit {
  const wanted = new Set(stale.map((i) => scopedKey(i.scope, i.project)));
  return (entries) => {
    const user = entries.find(
      (entry) => isRecord(entry) && entry.scope === "user",
    ) as Record<string, unknown> | undefined;
    const commit =
      user?.version === version && typeof user.gitCommitSha === "string"
        ? user.gitCommitSha
        : undefined;
    const settled = new Set<string>();
    let changed = false;
    const next = entries.map((entry) => {
      const key = entryKey(entry);
      if (!wanted.has(key) || !isRecord(entry)) return entry;
      settled.add(key);
      if (entry.version === version && entry.installPath === installPath)
        return entry;
      changed = true;
      const { gitCommitSha: _stale, ...rest } = entry;
      return {
        ...rest,
        installPath,
        version,
        lastUpdated: currentIso(),
        ...(commit === undefined ? {} : { gitCommitSha: commit }),
      };
    });
    return { entries: next, settled, changed };
  };
}

/**
 * What became of one scoped install in an upgrade: `refreshed` or
 * `unchanged` by `claude plugin update`, `rewritten` to the user-scope
 * version in the install record when that update cannot reach it (`detail`
 * names the directory it reached instead), `removed` from the record when its
 * directory is gone, `left` as it was when none could be done safely
 * (`detail` says why).
 */
export interface ScopedResult {
  scope: ScopedInstall["scope"];
  project: string;
  before: string;
  version?: string;
  outcome: "refreshed" | "unchanged" | "rewritten" | "removed" | "left";
  detail: string;
}

function scopedResult(
  install: ScopedInstall,
  outcome: ScopedResult["outcome"],
  detail: string,
  /** Null for an install that is gone. */
  version: string | null = install.version,
): ScopedResult {
  return {
    scope: install.scope,
    project: install.project,
    before: install.version,
    ...(version === null ? {} : { version }),
    outcome,
    detail,
  };
}

/** Removes each install whose directory is gone from the record; what became of each. */
function removeGone(
  gone: readonly ScopedInstall[],
  record: string,
  say: Say,
): ScopedResult[] {
  if (gone.length === 0) return [];
  say(
    `$ remove ${gone.length} ${PLUGIN_ID} install${gone.length === 1 ? "" : "s"} whose directory no longer exists from ${record}`,
  );
  const dropped = editRecord(record, dropGone(gone));
  return gone.map((install) =>
    typeof dropped === "string"
      ? scopedResult(install, "left", dropped)
      : dropped.has(scopedKey(install.scope, install.project))
        ? scopedResult(
            install,
            "removed",
            "its directory no longer exists",
            null,
          )
        : scopedResult(install, "left", `${record} no longer lists it as gone`),
  );
}

/** One `claude plugin update` run for a repository's stale installs. */
interface Update {
  /** The directory it ran from. */
  from: string;
  /** The directory its result says it updated, when it names one. */
  reached: string | null;
  /** Why it failed, when it did. */
  error?: string;
}

/**
 * Runs `claude plugin update` once for each repository among `stale` (each
 * directory outside a checkout is its own), from its first stale install's
 * directory; the update each stale install's repository got. An install an
 * earlier update said it refreshed gets none of its own.
 */
function updateEachRepository(
  program: string,
  stale: readonly ScopedInstall[],
  say: Say,
  repository: (dir: string) => string | null,
): Map<string, Update> {
  const byRepository = new Map<string, Update>();
  const reached = new Set<string>();
  const updates = new Map<string, Update>();
  for (const install of stale) {
    const here = directoryKey(install.project);
    const group = scopedKey(install.scope, repository(install.project) ?? here);
    let update = byRepository.get(group);
    if (update === undefined) {
      if (reached.has(scopedKey(install.scope, here))) continue;
      try {
        const output = run(
          program,
          ["plugin", "update", PLUGIN_ID, "--scope", install.scope, "--json"],
          say,
          install.project,
        );
        update = { from: install.project, reached: updatedProject(output) };
        if (update.reached !== null)
          reached.add(scopedKey(install.scope, directoryKey(update.reached)));
      } catch (error) {
        update = { from: install.project, reached: null, error: reason(error) };
      }
      byRepository.set(group, update);
    }
    updates.set(scopedKey(install.scope, install.project), update);
  }
  return updates;
}

/**
 * Why `update` cannot reach `install`, which it left behind `current`: it
 * refreshed another directory, or another worktree of the same repository is
 * at `current`. Null when neither shows, which leaves the cause unknown.
 */
function unreachedBy(
  install: ScopedInstall,
  update: Update | undefined,
  listed: readonly ScopedInstall[],
  current: string,
  repository: (dir: string) => string | null,
): string | null {
  if (update === undefined || update.error !== undefined) return null;
  const here = directoryKey(install.project);
  if (update.reached !== null && directoryKey(update.reached) !== here)
    return update.from === install.project
      ? `claude plugin update from ${install.project} refreshed ${update.reached} instead`
      : `claude plugin update, run once for its repository from ${update.from}, refreshed ${update.reached}, not this one`;
  const repo = repository(install.project);
  if (repo === null) return null;
  const sibling = listed.find(
    (entry) =>
      entry.scope === install.scope &&
      entry.version === current &&
      directoryKey(entry.project) !== here &&
      directoryState(entry.project) === "present" &&
      repository(entry.project) === repo,
  );
  return sibling === undefined
    ? null
    : `claude plugin update from ${update.from} reaches ${sibling.project}, another worktree of the same repository, not this one`;
}

/**
 * Brings each install `claude plugin update` cannot reach to `current` in
 * the install record; what became of each.
 */
function rewriteUnreached(
  unreached: readonly { install: ScopedInstall; detail: string }[],
  current: string,
  installPath: string | null,
  record: string,
  say: Say,
): ScopedResult[] {
  if (unreached.length === 0) return [];
  if (installPath === null)
    return unreached.map(({ install, detail }) =>
      scopedResult(
        install,
        "left",
        `${detail}; claude plugin list names no folder for the user-scope install, so its record is not refreshed`,
      ),
    );
  say(
    `$ point ${unreached.length} ${PLUGIN_ID} install${unreached.length === 1 ? "" : "s"} claude plugin update cannot reach at the user-scope ${current} in ${record}`,
  );
  const done = editRecord(
    record,
    pointAtUserInstall(
      unreached.map((u) => u.install),
      current,
      installPath,
    ),
  );
  return unreached.map(({ install, detail }) =>
    typeof done === "string"
      ? scopedResult(install, "left", `${detail}; ${done}`)
      : done.has(scopedKey(install.scope, install.project))
        ? scopedResult(
            install,
            "rewritten",
            `${detail}; refreshed to ${current} in the install record`,
            current,
          )
        : scopedResult(
            install,
            "left",
            `${detail}; ${record} no longer lists it`,
          ),
  );
}

/** What each present install is at now, after the updates. */
function settled(
  program: string,
  present: readonly ScopedInstall[],
  current: string | null,
  updates: ReadonlyMap<string, Update>,
  repository: (dir: string) => string | null,
): {
  results: ScopedResult[];
  unreached: { install: ScopedInstall; detail: string }[];
} {
  const unreached: { install: ScopedInstall; detail: string }[] = [];
  if (present.length === 0) return { results: [], unreached };
  let listed: ScopedInstall[];
  try {
    listed = scopedInstalls(program);
  } catch (error) {
    return {
      results: present.map((install) =>
        scopedResult(
          install,
          "left",
          `updated, but its version cannot be read back: ${reason(error)}`,
        ),
      ),
      unreached,
    };
  }
  const now = new Map(
    listed.map((entry) => [
      scopedKey(entry.scope, entry.project),
      entry.version,
    ]),
  );
  const results = present.flatMap((install): ScopedResult[] => {
    const key = scopedKey(install.scope, install.project);
    const version = now.get(key);
    const update = updates.get(key);
    if (version === undefined)
      return [
        scopedResult(
          install,
          "left",
          "claude plugin update finished, but claude plugin list no longer lists it",
        ),
      ];
    if (current !== null && version !== current) {
      if (update?.error !== undefined)
        return [
          scopedResult(
            install,
            "left",
            update.from === install.project
              ? update.error
              : `claude plugin update for its repository, run from ${update.from}, failed: ${update.error}`,
          ),
        ];
      const detail = unreachedBy(install, update, listed, current, repository);
      if (detail !== null) {
        unreached.push({ install, detail });
        return [];
      }
      return [
        scopedResult(
          install,
          "left",
          `claude plugin update finished, but the scoped record remains at ${version}; expected ${current}. Inspect it with claude plugin list --json before repairing the scoped install`,
          version,
        ),
      ];
    }
    return [
      version === install.version
        ? scopedResult(install, "unchanged", `already at ${version}`)
        : scopedResult(
            install,
            "refreshed",
            `${install.version} → ${version}`,
            version,
          ),
    ];
  });
  return { results, unreached };
}

/** `lookup`, asked at most once per directory. */
function remembered(
  lookup: (dir: string) => string | null,
): (dir: string) => string | null {
  const known = new Map<string, string | null>();
  return (dir) => {
    const key = directoryKey(dir);
    if (!known.has(key)) known.set(key, lookup(dir));
    return known.get(key) ?? null;
  };
}

/**
 * Brings each of Claude Code's project- and local-scope installs to
 * `current` (the user-scope version), as the module comment says; says what
 * became of each that changed or was left.
 */
export function refreshScoped(
  program: string,
  say: Say,
  current: string | null = null,
  record: string = claudeInstallRecord(),
  repository: (dir: string) => string | null = repositoryOf,
): ScopedResult[] {
  const listing = json(program, ["plugin", "list", "--json"]);
  const left: ScopedResult[] = [];
  const gone: ScopedInstall[] = [];
  const present: ScopedInstall[] = [];
  for (const install of claudeScopedInstalls(listing)) {
    const where = directoryState(install.project);
    if (where === "gone") gone.push(install);
    else if (where !== "present")
      left.push(scopedResult(install, "left", where));
    else present.push(install);
  }
  const repositoryOfDir = remembered(repository);
  const updates = updateEachRepository(
    program,
    present.filter((install) => install.version !== current),
    say,
    repositoryOfDir,
  );
  const removed = removeGone(gone, record, say);
  const after = settled(program, present, current, updates, repositoryOfDir);
  const results = [
    ...left,
    ...removed,
    ...after.results,
    ...(current === null
      ? []
      : rewriteUnreached(
          after.unreached,
          current,
          userInstallPath(listing),
          record,
          say,
        )),
  ];
  for (const result of results)
    if (result.outcome !== "unchanged")
      say(
        `claude: ${PLUGIN_ID} ${result.before} for ${result.project} (${result.scope} scope): ${result.outcome}, ${result.detail}`,
      );
  return results;
}

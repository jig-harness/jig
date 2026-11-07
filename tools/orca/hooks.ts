/**
 * The repository's worktree hooks and the worktree's reflection journal, as
 * the Orca workspace tool reaches them on the clone's host: through the
 * host context, so the same step runs on this machine and over SSH. The
 * create hook's run-once rules, and the reads of the host they need, are
 * shared with the plugin (plugin/shared/orca-workspace/hooks.ts); the
 * background setup tab and the reflection journal's checks are here.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  mergeLayers,
  nonEmpty,
  OVERLAY_RELPATH,
  parseConfigText,
  USER_CONFIG_FILE,
  userLayerEnabled,
  valueAt,
} from "../../plugin/shared/config-layers.ts";
import { DEFAULT_JOURNAL_IN_GIT_DIR } from "../../plugin/skills/reflect/scripts/lib/context.ts";
import {
  readJournal,
  unsent,
} from "../../plugin/skills/reflect/scripts/lib/journal.ts";
import { expandPathWith } from "../../plugin/skills/reflect/scripts/lib/settings.ts";
import {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
  exists,
  gitDirOf,
  hookOf,
  inspectPath,
} from "../../plugin/shared/orca-workspace/hooks.ts";
import { HOOKS_DIR } from "../../plugin/shared/orca-workspace/limits.ts";
import { shellQuote } from "../herdr/remote.ts";
import { output } from "../herdr/runner.ts";
import { orcaJson } from "./cli.ts";
import { OrcaError, type Workspace } from "./runner.ts";

export {
  CREATE_HOOK_CLAIM,
  CREATE_HOOK_MARK,
  ensureCreateHook,
  exists,
  failureReason,
  gitDirOf,
  hookOf,
  inspectCommand,
  inspectPath,
  type PathKind,
  releaseClaim,
} from "../../plugin/shared/orca-workspace/hooks.ts";

/**
 * The script a background setup tab runs, as `sh -c <script> sh <claim>
 * <mark> <hook> <worktree>`: the same claim and mark as `ensureCreateHook`,
 * so the hook still runs once per worktree whichever way an open started it.
 * A claim another open holds is told from any other `mkdir` failure by the
 * reason it gives, as `takeHookClaim` tells it; a mark that cannot be written
 * fails the run, as `runClaimedHook` fails it.
 */
export const BACKGROUND_SETUP_SCRIPT = [
  'if ! e=$(LC_ALL=C mkdir "$1" 2>&1); then',
  '  case "$e" in *": File exists") echo "setup: another open is running it"; exit 0 ;; esac',
  '  echo "✗ setup could not take its claim: $e"; exit 1',
  "fi",
  'if [ -f "$2" ]; then rm -rf "$1"; echo "setup: already done"; exit 0; fi',
  'cd "$4" && "$3"; s=$?',
  'if [ "$s" -ne 0 ]; then echo "✗ setup failed (exit $s); open the issue again to run it again"',
  'elif printf ok > "$2"; then echo "✓ setup done"',
  'else s=1; echo "✗ setup ran, but its mark $2 could not be written; open the issue again to run it again"; fi',
  'rm -rf "$1"; exit "$s"',
].join("\n");

/** The command line a background setup tab is started with. */
export function backgroundSetupCommand(
  claim: string,
  mark: string,
  hook: string,
  worktree: string,
): string {
  return [
    "sh",
    "-c",
    BACKGROUND_SETUP_SCRIPT,
    "sh",
    claim,
    mark,
    hook,
    worktree,
  ]
    .map(shellQuote)
    .join(" ");
}

/** What `startCreateHook` did: started a tab, found the hook done or running, or found no hook. */
export type BackgroundSetup = "started" | "done" | "running" | "none";

/**
 * Start the repository's create hook in an Orca terminal tab named `setup`
 * and return at once, for an open that starts no agent: the person watches
 * the tab and starts an agent when it is done. Nothing is started when the
 * mark says the hook ran, or a claim says an open is running it; two opens
 * that both start a tab still run the hook once, since the tab's script
 * takes the claim itself (`BACKGROUND_SETUP_SCRIPT`). A claim the tab never
 * gave back, its tab closed before the hook ended, reads as running, so the
 * open names it and how to clear it; anything but a directory at the claim's
 * path is refused.
 */
export function startCreateHook(
  ws: Workspace,
  worktree: { id: string; path: string },
  dir: string,
): BackgroundSetup {
  const hook = hookOf(ws, worktree.path, "create");
  if (hook === null) return "none";
  const mark = `${dir}/${CREATE_HOOK_MARK}`;
  const claim = `${dir}/${CREATE_HOOK_CLAIM}`;
  if (exists(ws, "-f", mark)) return "done";
  const held = inspectPath(ws, claim);
  if (held === "directory") {
    ws.host.log(
      `… ${HOOKS_DIR}/create is already running for this worktree (claim ${claim}); if no "setup" tab is running it, remove ${claim} and open the issue again, which runs it again`,
    );
    return "running";
  }
  if (held !== "absent")
    throw new OrcaError(
      `${claim} is a ${held === "file" ? "file" : "special file"}, not the create hook's claim; remove it and open the issue again`,
    );
  orcaJson(
    ws,
    [
      "terminal",
      "create",
      "--worktree",
      `id:${worktree.id}`,
      "--title",
      "setup",
      "--command",
      backgroundSetupCommand(claim, mark, hook, worktree.path),
    ],
    "orca terminal create",
  );
  ws.host.log(`… ${HOOKS_DIR}/create is running in the worktree's "setup" tab`);
  return "started";
}

/** Why a removal stops when the journal's place is in doubt; every refusal below ends with it. */
const REFUSED =
  "where the reflection journal is cannot be told, so the worktree is not removed";

/** The variables that choose the configuration layers, and the home directory `~` names, read from the host's shell. */
const HOST_VARIABLES = [
  "HOME",
  "JIG_HOME",
  "JIG_OVERLAY",
  "JIG_USER_LAYER",
] as const;
type HostEnvironment = Record<
  (typeof HOST_VARIABLES)[number],
  string | undefined
>;

/** The shell script that prints each of `HOST_VARIABLES`, NUL-terminated, so a value holds anything. */
export const HOST_ENVIRONMENT_SCRIPT = HOST_VARIABLES.map(
  (name) => `printf '%s\\0' "\${${name}-}"`,
).join(" && ");

/**
 * The host's layer-selection variables and home directory, as its
 * non-interactive shell has them; an unset one is undefined, as a blank one
 * is to the shared reader (`nonEmpty`).
 */
function hostEnvironment(ws: Workspace, host: string): HostEnvironment {
  const done = ws.host.run(["sh", "-c", HOST_ENVIRONMENT_SCRIPT]);
  const values = done.stdout.split("\0");
  if (
    done.status !== 0 ||
    values.length !== HOST_VARIABLES.length + 1 ||
    values[HOST_VARIABLES.length] !== ""
  )
    throw new OrcaError(
      `cannot read the environment of ${host}: ${output(done)}; ${REFUSED}`,
    );
  return Object.fromEntries(
    HOST_VARIABLES.map((name, at) => [name, nonEmpty(values[at])]),
  ) as HostEnvironment;
}

/**
 * The configuration files the reflect skill reads on the host, chosen as the
 * shared reader chooses them from a process's environment, from the host's:
 * the user's `$JIG_HOME/jig.yaml`, else `~/.jig/jig.yaml`, and none under
 * `JIG_USER_LAYER=off`; the worktree's `.config/jig.yaml`, or the file
 * `JIG_OVERLAY` names instead. The shared reader resolves a relative
 * `JIG_HOME` or `JIG_OVERLAY` against its own working directory, which a
 * session on the host has and this tool does not, so one refuses, as does a
 * `JIG_USER_LAYER` the reader would refuse.
 */
function hostLayerFiles(
  path: string,
  env: HostEnvironment,
  home: string,
  host: string,
): { user: string | null; repository: string } {
  const absolute = (name: "JIG_HOME" | "JIG_OVERLAY"): string | undefined => {
    const value = env[name];
    if (value !== undefined && !posix.isAbsolute(value))
      throw new OrcaError(
        `${name} on ${host} is the relative path ${JSON.stringify(value)}, which a session there resolves against its own directory; ${REFUSED}`,
      );
    return value;
  };
  let userLayer: boolean;
  try {
    userLayer = userLayerEnabled(env);
  } catch (error) {
    throw new OrcaError(
      `${error instanceof Error ? error.message : String(error)} on ${host}; ${REFUSED}`,
    );
  }
  return {
    user: userLayer
      ? posix.join(
          absolute("JIG_HOME") ?? posix.join(home, ".jig"),
          USER_CONFIG_FILE,
        )
      : null,
    repository: absolute("JIG_OVERLAY") ?? posix.join(path, OVERLAY_RELPATH),
  };
}

/**
 * One configuration layer's file on the host, parsed as the shared reader
 * parses it; null when nothing is at its path. One that is not a regular
 * file, or cannot be read or parsed, refuses, since where the journal is
 * cannot then be told.
 */
function hostConfigLayer(
  ws: Workspace,
  file: string,
  host: string,
): Record<string, unknown> | null {
  const kind = inspectPath(ws, file);
  if (kind === "absent") return null;
  if (kind !== "file")
    throw new OrcaError(
      `${file} on ${host} is a ${kind === "directory" ? "directory" : "special file"}, not a configuration file; ${REFUSED}`,
    );
  const read = ws.host.run(["cat", file]);
  if (read.status !== 0)
    throw new OrcaError(
      `cannot read ${file} on ${host}: ${output(read)}; ${REFUSED}`,
    );
  try {
    return parseConfigText(read.stdout, `${file} on ${host}`);
  } catch (error) {
    throw new OrcaError(
      `${error instanceof Error ? error.message : String(error)}; ${REFUSED}`,
    );
  }
}

/** The host's home directory from its environment; refused unless absolute. */
function hostHome(
  env: Record<string, string | undefined>,
  host: string,
): string {
  const home = env.HOME;
  if (home === undefined || !posix.isAbsolute(home))
    throw new OrcaError(
      `the home directory on ${host} (HOME=${JSON.stringify(home ?? "")}) is not an absolute path; ${REFUSED}`,
    );
  return home;
}

/**
 * Where the worktree's reflection journal is on the host, as the reflect
 * skill resolves it there: `reflection.journal` from the configuration
 * files the host's environment selects (`hostLayerFiles`), the user's under
 * the worktree's, expanded as the skill expands a path setting
 * (`expandPathWith`: `~` is the host's home directory, a relative path the
 * worktree's); the journal's default place in the worktree's git directory
 * when neither sets it. A setting that is not a path refuses, as the skill
 * refuses it. The selection variables come from the host's non-interactive
 * shell; the `JIG__…` environment layer, which a session on the host sets,
 * is not read.
 */
export function hostJournalPath(
  ws: Workspace,
  path: string,
  host: string,
): string {
  const env = hostEnvironment(ws, host);
  const home = hostHome(env, host);
  const files = hostLayerFiles(path, env, home, host);
  const merged = mergeLayers(
    files.user === null ? {} : (hostConfigLayer(ws, files.user, host) ?? {}),
    hostConfigLayer(ws, files.repository, host) ?? {},
  );
  const configured = valueAt(merged, ["reflection", "journal"]);
  if (configured === undefined)
    return `${gitDirOf(ws, path)}/${DEFAULT_JOURNAL_IN_GIT_DIR}`;
  if (typeof configured !== "string" || configured.trim() === "")
    throw new OrcaError(
      `reflection.journal in the Jig configuration on ${host} must be a path; fix it there, then remove the worktree again`,
    );
  return expandPathWith(configured, path, home, posix);
}

/**
 * Refuse to remove a worktree on a server's host while its reflection
 * journal holds unsent findings: the host has nothing from Jig to park them
 * with, and a journal kept in the worktree goes with it. The journal is
 * looked for where the host's configuration puts it (`hostJournalPath`),
 * read over SSH and judged here with the reflect skill's own reader.
 */
export function assertNoUnsentFindings(
  ws: Workspace,
  path: string,
  host: string,
): void {
  const journal = hostJournalPath(ws, path, host);
  const kind = inspectPath(ws, journal);
  if (kind === "absent") {
    ws.host.log(
      `↺ ${path} has no reflection journal; nothing to park on ${host}`,
    );
    return;
  }
  if (kind !== "file")
    throw new OrcaError(
      `${journal} on ${host} is a ${kind === "directory" ? "directory" : "special file"}, not a reflection journal; ${REFUSED}`,
    );
  const read = ws.host.run(["cat", journal]);
  if (read.status !== 0)
    throw new OrcaError(
      `cannot read ${journal} on ${host}: ${output(read)}; not removing ${path}`,
    );
  const copyDir = mkdtempSync(join(tmpdir(), "orca-journal-"));
  let count: number;
  try {
    const copy = join(copyDir, "reflection-journal.jsonl");
    writeFileSync(copy, read.stdout);
    count = unsent(readJournal(copy)).length;
  } catch (error) {
    throw new OrcaError(
      `cannot read the reflection journal of ${path} (${journal} on ${host}): ${error instanceof Error ? error.message : String(error)}; repair it there, then remove the worktree again`,
    );
  } finally {
    rmSync(copyDir, { recursive: true, force: true });
  }
  if (count > 0)
    throw new OrcaError(
      `${path} has ${count} unsent reflection finding(s) in ${journal}, which removing it would delete, and ${host} has nothing from Jig to park them with; run /jig:reflect in the worktree on ${host}, or park them there with the reflect skill's journal.ts park, then remove the worktree again`,
    );
  ws.host.log(
    `↺ ${path} has no unsent reflection findings; nothing to park on ${host}`,
  );
}

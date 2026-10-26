/**
 * The repository's worktree hooks and the worktree's reflection journal, as
 * the Orca workspace tool reaches them on the clone's host: through the
 * host context, so the same step runs on this machine and over SSH. What is
 * at a path on the host is read here too (`inspectPath`), with the host's
 * answer taken from the reason it gives and nowhere else.
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
import { HOOK_TIMEOUT_MS, HOOKS_DIR } from "../herdr/lifecycle.ts";
import { shellQuote } from "../herdr/remote.ts";
import { budget, output } from "../herdr/runner.ts";
import { OrcaError, WAIT_POLL_MS, type Workspace } from "./runner.ts";

/** The file in a worktree's git directory that records its create hook succeeded. */
export const CREATE_HOOK_MARK = "jig-orca-create-hook";
/**
 * The directory beside the mark that one open holds while it runs the create
 * hook: `mkdir` creates it for exactly one of several opens, and the others
 * wait for the mark.
 */
export const CREATE_HOOK_CLAIM = `${CREATE_HOOK_MARK}.claim`;

/** What is at a path on the host, or that nothing is. */
export type PathKind = "file" | "directory" | "other" | "absent";

/** The command that lists one path on the host, as `inspectPath` reads it. */
export function inspectCommand(file: string): string[] {
  return ["env", "LC_ALL=C", "ls", "-ldL", "--", file];
}

/**
 * Why a command on the host failed, as its diagnostic ends: the text after
 * the last `: ` of the diagnostic's last line, which is where `ls`, `mkdir`
 * and the other utilities put the reason, after their own name and the path
 * (quoted or not). Read there, a path that happens to contain a reason's
 * words, as a directory named for one would, is never read as that reason.
 * Null when the diagnostic ends with no such line.
 */
export function failureReason(stderr: string): string | null {
  const line = stderr.trimEnd().split("\n").at(-1) ?? "";
  const at = line.lastIndexOf(": ");
  return at === -1 ? null : line.slice(at + 2).trim();
}

/** The reasons a listing fails for when nothing is at the path (`ENOENT`), or the path runs through a file (`ENOTDIR`). */
const ABSENT_REASONS = new Set([
  "No such file or directory",
  "Not a directory",
]);

/**
 * What is at `file` on the host. The entry is listed (`ls -ldL`, following a
 * symbolic link, under the C locale so the messages read alike everywhere),
 * and the first character of the listing says what it is. A listing that
 * fails means absence only when the reason it gives (`failureReason`) is
 * that nothing is there, never by its exit status alone, and never by those
 * words anywhere else in its message: `test -f` answers no alike for a path
 * that is absent, a parent that cannot be searched and a filesystem error,
 * and a removal that read the second or third as the first would delete
 * findings it never saw. Any other failure is an error.
 */
export function inspectPath(ws: Workspace, file: string): PathKind {
  const listed = ws.host.run(inspectCommand(file));
  if (listed.status === 0) {
    const type = listed.stdout.trimStart().charAt(0);
    if (type === "-") return "file";
    if (type === "d") return "directory";
    if (/^[a-z]$/i.test(type)) return "other";
  } else if (ABSENT_REASONS.has(failureReason(listed.stderr) ?? "")) {
    return "absent";
  }
  throw new OrcaError(`cannot tell what is at ${file}: ${output(listed)}`);
}

/** Whether a regular file (`-f`) or a directory (`-d`) is at `file` on the host; something else, or nothing, is no. */
export function exists(
  ws: Workspace,
  flag: "-f" | "-d",
  file: string,
): boolean {
  return inspectPath(ws, file) === (flag === "-f" ? "file" : "directory");
}

/** The worktree's executable hook of `kind`, or null when it has none. */
export function hookOf(
  ws: Workspace,
  path: string,
  kind: "create" | "remove",
): string | null {
  const file = `${path}/${HOOKS_DIR}/${kind}`;
  const test = ws.host.run(["test", "-x", file]);
  if (test.status === 0) return file;
  if (test.status === 1) return null;
  throw new OrcaError(`cannot tell whether ${file} exists: ${output(test)}`);
}

/** The worktree's own git directory, where its create hook's mark and claim are kept. */
export function gitDirOf(ws: Workspace, path: string): string {
  const dir = ws.host.run([
    "git",
    "-C",
    path,
    "rev-parse",
    "--absolute-git-dir",
  ]);
  if (dir.status !== 0 || dir.stdout.trim() === "")
    throw new OrcaError(
      `cannot read the git directory of ${path}: ${output(dir)}`,
    );
  return dir.stdout.trim();
}

/**
 * Take the create hook's claim on the host, which `mkdir` does for exactly
 * one open. False when another open holds it, read from the reason the
 * `mkdir` failed for (`failureReason`) and not from a second look at the
 * claim: by then the holder may have left its mark and given the claim
 * back, and that look would read a claim that was held as one that could
 * not be taken, where the next turn of the wait reads the mark. Any other
 * failure is an error.
 */
function takeHookClaim(ws: Workspace, claim: string): boolean {
  const made = ws.host.run(["mkdir", claim]);
  if (made.status === 0) return true;
  if (failureReason(made.stderr) === "File exists") return false;
  throw new OrcaError(
    `could not take the create hook's claim ${claim}: ${output(made)}`,
  );
}

/** Give the create hook's claim back; a claim that stays would make the next open wait for it. */
function releaseHookClaim(ws: Workspace, claim: string): void {
  const removed = ws.host.run(["rm", "-rf", claim]);
  if (removed.status !== 0)
    ws.host.log(
      `⚠ could not remove the create hook's claim ${claim} (${output(removed)}); remove it before opening the workspace again`,
    );
}

/**
 * The mark, read under the claim this open just took. A mark not seen before
 * the claim is judged only here, since the holder writes the mark before
 * giving the claim back. True when the mark is there, so the hook has run,
 * and the claim is given back; false when there is none and this open did
 * not wait, so it keeps the claim and runs the hook. No mark after a wait
 * means the run this open waited for ended without one, so it failed: the
 * claim is given back and the open stops.
 */
function markUnderClaim(
  ws: Workspace,
  hook: string,
  mark: string,
  claim: string,
  waited: boolean,
): boolean {
  let marked: boolean;
  try {
    marked = exists(ws, "-f", mark);
  } catch (error) {
    releaseHookClaim(ws, claim);
    throw error;
  }
  if (!marked && !waited) return false;
  releaseHookClaim(ws, claim);
  if (marked) return true;
  throw new OrcaError(
    `the run of ${hook} this open waited for ended without leaving its mark, so it failed; fix the hook and open the workspace again, which runs it again`,
  );
}

/**
 * Take the create hook's claim, or wait for the open that holds it, up to
 * the hook's limit. True when the mark is there, so the hook has run; false
 * once this open holds the claim with no mark under it (`markUnderClaim`).
 * A mark seen is final, so it is trusted at once. The limit passing stops a
 * wait.
 */
function awaitHookClaim(
  ws: Workspace,
  hook: string,
  mark: string,
  claim: string,
): boolean {
  const deadline = Date.now() + budget(ws.host, HOOK_TIMEOUT_MS);
  let waited = false;
  for (;;) {
    if (exists(ws, "-f", mark)) return true;
    if (takeHookClaim(ws, claim))
      return markUnderClaim(ws, hook, mark, claim, waited);
    if (!waited)
      ws.host.log(
        `… waiting for ${HOOKS_DIR}/create, which another open is running`,
      );
    waited = true;
    if (Date.now() >= deadline)
      throw new OrcaError(
        `${hook} did not finish within ${HOOK_TIMEOUT_MS / 60_000} minutes; if no process is still running it, remove ${claim} and open the workspace again, which runs it again`,
      );
    ws.host.sleep(WAIT_POLL_MS);
  }
}

/** Run the hook under the claim this open holds, leave the mark, and give the claim back either way. */
function runClaimedHook(
  ws: Workspace,
  path: string,
  hook: string,
  mark: string,
  claim: string,
): void {
  ws.host.log(`… running ${HOOKS_DIR}/create`);
  try {
    ws.runHook(ws.host, path, hook, `${claim}/hook`);
  } catch (error) {
    releaseHookClaim(ws, claim);
    throw new OrcaError(
      `${error instanceof Error ? error.message : String(error)}; fix the hook and open the workspace again, which runs it again`,
    );
  }
  const written = ws.host.run(["sh", "-c", `printf ok > ${shellQuote(mark)}`]);
  releaseHookClaim(ws, claim);
  if (written.status !== 0)
    throw new OrcaError(
      `could not record that the create hook ran (${mark}): ${output(written)}`,
    );
}

/**
 * Run the repository's create hook once per worktree, however many opens
 * reach it at once. The open that creates the claim directory beside the
 * mark, in the worktree's git directory `dir`, and finds no mark under it,
 * runs the hook; every other open waits for the mark. A run that succeeded
 * leaves the mark and gives the claim back; one that failed gives the claim
 * back and leaves no mark, so the next open runs the hook again.
 * On this machine the hook runs under the Herdr tool's supervisor, which
 * ends it and its children when it fails or outlives its limit. True when
 * this run ran it.
 */
export function ensureCreateHook(
  ws: Workspace,
  path: string,
  dir: string,
): boolean {
  const hook = hookOf(ws, path, "create");
  if (hook === null) return false;
  const mark = `${dir}/${CREATE_HOOK_MARK}`;
  const claim = `${dir}/${CREATE_HOOK_CLAIM}`;
  if (awaitHookClaim(ws, hook, mark, claim)) return false;
  runClaimedHook(ws, path, hook, mark, claim);
  return true;
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
  const home = env.HOME;
  if (home === undefined || !posix.isAbsolute(home))
    throw new OrcaError(
      `the home directory on ${host} (HOME=${JSON.stringify(home ?? "")}) is not an absolute path; ${REFUSED}`,
    );
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

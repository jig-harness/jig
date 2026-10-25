/**
 * The repository's worktree hooks and the worktree's reflection journal, as
 * the Orca workspace tool reaches them on the clone's host: through the
 * host context, so the same step runs on this machine and over SSH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  mergeLayers,
  OVERLAY_RELPATH,
  parseConfigText,
  USER_CONFIG_FILE,
  valueAt,
} from "../../plugin/shared/config-layers.ts";
import { DEFAULT_JOURNAL_IN_GIT_DIR } from "../../plugin/skills/reflect/scripts/lib/context.ts";
import {
  readJournal,
  unsent,
} from "../../plugin/skills/reflect/scripts/lib/journal.ts";
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

/** Whether `file` passes `test <flag>` on the host; any answer but yes or no is an error. */
export function exists(
  ws: Workspace,
  flag: "-f" | "-d",
  file: string,
): boolean {
  const test = ws.host.run(["test", flag, file]);
  if (test.status === 0) return true;
  if (test.status === 1) return false;
  throw new OrcaError(`cannot tell whether ${file} exists: ${output(test)}`);
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

/** Take the create hook's claim on the host; false when another open holds it. */
function takeHookClaim(ws: Workspace, claim: string): boolean {
  const made = ws.host.run(["mkdir", claim]);
  if (made.status === 0) return true;
  if (exists(ws, "-d", claim)) return false;
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
 * mark, and finds no mark under it, runs the hook; every other open waits
 * for the mark. A run that succeeded leaves the mark and gives the claim
 * back; one that failed gives the claim back and leaves no mark, so the
 * next open runs the hook again.
 * On this machine the hook runs under the Herdr tool's supervisor, which
 * ends it and its children when it fails or outlives its limit. True when
 * this run ran it.
 */
export function ensureCreateHook(ws: Workspace, path: string): boolean {
  const hook = hookOf(ws, path, "create");
  if (hook === null) return false;
  const dir = gitDirOf(ws, path);
  const mark = `${dir}/${CREATE_HOOK_MARK}`;
  const claim = `${dir}/${CREATE_HOOK_CLAIM}`;
  if (awaitHookClaim(ws, hook, mark, claim)) return false;
  runClaimedHook(ws, path, hook, mark, claim);
  return true;
}

/** One value the host's shell prints for `script`; a failure, or nothing, is an error naming `what`. */
function hostShellValue(
  ws: Workspace,
  script: string,
  what: string,
  host: string,
): string {
  const done = ws.host.run(["sh", "-c", script]);
  const value = done.stdout.trim();
  if (done.status !== 0 || value === "")
    throw new OrcaError(`cannot read ${what} on ${host}: ${output(done)}`);
  return value;
}

/**
 * One configuration layer's file on the host, parsed as the shared reader
 * parses it; null when the host has no such file. One that cannot be read
 * or parsed refuses, since where the journal is cannot then be told.
 */
function hostConfigLayer(
  ws: Workspace,
  file: string,
  host: string,
): Record<string, unknown> | null {
  if (!exists(ws, "-f", file)) return null;
  const read = ws.host.run(["cat", file]);
  const refused =
    "where the reflection journal is cannot be told, so the worktree is not removed";
  if (read.status !== 0)
    throw new OrcaError(
      `cannot read ${file} on ${host}: ${output(read)}; ${refused}`,
    );
  try {
    return parseConfigText(read.stdout, `${file} on ${host}`);
  } catch (error) {
    throw new OrcaError(
      `${error instanceof Error ? error.message : String(error)}; ${refused}`,
    );
  }
}

/**
 * Where the worktree's reflection journal is on the host, as the reflect
 * skill resolves it there: `reflection.journal` from the configuration
 * layers that are files on the host, the user's (`$JIG_HOME/jig.yaml`, else
 * `~/.jig/jig.yaml`) under the worktree's (`.config/jig.yaml`), with `~`
 * read as the host's home directory and a relative path from the worktree;
 * the journal's default place in the worktree's git directory when neither
 * sets it. A setting that is not a path refuses, as the skill refuses it.
 * The environment layer (`JIG__…` variables) belongs to a session on the
 * host, which the tool cannot see from here.
 */
export function hostJournalPath(
  ws: Workspace,
  path: string,
  host: string,
): string {
  const userFile = hostShellValue(
    ws,
    `printf %s "\${JIG_HOME:-$HOME/.jig}/${USER_CONFIG_FILE}"`,
    "where the user's Jig configuration is",
    host,
  );
  const merged = mergeLayers(
    hostConfigLayer(ws, userFile, host) ?? {},
    hostConfigLayer(ws, `${path}/${OVERLAY_RELPATH}`, host) ?? {},
  );
  const configured = valueAt(merged, ["reflection", "journal"]);
  if (configured === undefined)
    return `${gitDirOf(ws, path)}/${DEFAULT_JOURNAL_IN_GIT_DIR}`;
  if (typeof configured !== "string" || configured.trim() === "")
    throw new OrcaError(
      `reflection.journal in the Jig configuration on ${host} must be a path; fix it there, then remove the worktree again`,
    );
  if (configured === "~" || configured.startsWith("~/"))
    return posix.join(
      hostShellValue(ws, 'printf %s "$HOME"', "the home directory", host),
      configured.slice(2),
    );
  return posix.isAbsolute(configured)
    ? configured
    : posix.join(path, configured);
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
  if (!exists(ws, "-f", journal)) {
    ws.host.log(
      `↺ ${path} has no reflection journal; nothing to park on ${host}`,
    );
    return;
  }
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

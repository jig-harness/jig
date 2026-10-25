/**
 * The repository's worktree hooks and the worktree's reflection journal, as
 * the Orca workspace tool reaches them on the clone's host: through the
 * host context, so the same step runs on this machine and over SSH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * Take the create hook's claim, or wait for the open that holds it, up to
 * the hook's limit. True when the mark appeared, so the hook has run; false
 * once this open holds the claim. An open that waited stops when the run it
 * waited for ended without a mark, or when the limit passes.
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
    if (waited && !exists(ws, "-d", claim))
      throw new OrcaError(
        `the run of ${hook} this open waited for ended without leaving its mark, so it failed; fix the hook and open the workspace again, which runs it again`,
      );
    if (takeHookClaim(ws, claim)) return false;
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
 * mark runs the hook; every other open waits for the mark. A run that
 * succeeded leaves the mark and gives the claim back; one that failed gives
 * the claim back and leaves no mark, so the next open runs the hook again.
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

/**
 * Refuse to remove a worktree on a server's host while its reflection
 * journal holds unsent findings: the journal is in the worktree's git
 * directory, which the removal deletes, and the host has nothing from Jig to
 * park them with. The journal is read over SSH and judged here with the
 * reflect skill's own reader. Only the journal's default place is looked at:
 * the repository's `reflection.journal` setting is read where the skill runs.
 */
export function assertNoUnsentFindings(
  ws: Workspace,
  path: string,
  host: string,
): void {
  const journal = `${gitDirOf(ws, path)}/${DEFAULT_JOURNAL_IN_GIT_DIR}`;
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

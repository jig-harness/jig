/**
 * The repository's create hook, run once per worktree however many opens
 * reach it at once, and the reads of the clone's host it needs: what is at a
 * path (`inspectPath`, with the host's answer taken from the reason it gives
 * and nowhere else), the worktree's hook and its git directory. Every step
 * runs through the host context, so the same step runs on this machine and
 * over SSH.
 */
import { OrcaError } from "./envelope.ts";
import { HOOK_TIMEOUT_MS, HOOKS_DIR, WAIT_POLL_MS } from "./limits.ts";
import type { OpenPort } from "./port.ts";
import { budget, output, shellQuote } from "./runner.ts";

/** Reads and commands on the clone's host. */
export type OnHost = Pick<OpenPort, "host">;
/** The clone's host and how a hook runs there. */
export type OnHostWithHooks = Pick<OpenPort, "host" | "runHook">;

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
export function inspectPath(port: OnHost, file: string): PathKind {
  const listed = port.host.run(inspectCommand(file));
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
export function exists(port: OnHost, flag: "-f" | "-d", file: string): boolean {
  return inspectPath(port, file) === (flag === "-f" ? "file" : "directory");
}

/** The worktree's executable hook of `kind`, or null when it has none. */
export function hookOf(
  port: OnHost,
  path: string,
  kind: "create" | "remove",
): string | null {
  const file = `${path}/${HOOKS_DIR}/${kind}`;
  const test = port.host.run(["test", "-x", file]);
  if (test.status === 0) return file;
  if (test.status === 1) return null;
  throw new OrcaError(`cannot tell whether ${file} exists: ${output(test)}`);
}

/** The worktree's own git directory, where its create hook's mark and claim are kept. */
export function gitDirOf(port: OnHost, path: string): string {
  const dir = port.host.run([
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
function takeHookClaim(port: OnHost, claim: string): boolean {
  const made = port.host.run(["mkdir", claim]);
  if (made.status === 0) return true;
  if (failureReason(made.stderr) === "File exists") return false;
  throw new OrcaError(
    `could not take the create hook's claim ${claim}: ${output(made)}`,
  );
}

/**
 * Give a claim (`what`: whose it is) back; a claim that stays would make the
 * next open wait for it, so one that cannot be removed is named.
 */
export function releaseClaim(port: OnHost, claim: string, what: string): void {
  const removed = port.host.run(["rm", "-rf", claim]);
  if (removed.status !== 0)
    port.host.log(
      `⚠ could not remove ${what} claim ${claim} (${output(removed)}); remove it before opening again`,
    );
}

/** Give the create hook's claim back. */
function releaseHookClaim(port: OnHost, claim: string): void {
  releaseClaim(port, claim, "the create hook's");
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
  port: OnHost,
  hook: string,
  mark: string,
  claim: string,
  waited: boolean,
): boolean {
  let marked: boolean;
  try {
    marked = exists(port, "-f", mark);
  } catch (error) {
    releaseHookClaim(port, claim);
    throw error;
  }
  if (!marked && !waited) return false;
  releaseHookClaim(port, claim);
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
  port: OnHost,
  hook: string,
  mark: string,
  claim: string,
): boolean {
  const deadline = Date.now() + budget(port.host, HOOK_TIMEOUT_MS);
  let waited = false;
  for (;;) {
    if (exists(port, "-f", mark)) return true;
    if (takeHookClaim(port, claim))
      return markUnderClaim(port, hook, mark, claim, waited);
    if (!waited)
      port.host.log(
        `… waiting for ${HOOKS_DIR}/create, which another open is running`,
      );
    waited = true;
    if (Date.now() >= deadline)
      throw new OrcaError(
        `${hook} did not finish within ${HOOK_TIMEOUT_MS / 60_000} minutes; if no process is still running it, remove ${claim} and open the workspace again, which runs it again`,
      );
    port.host.sleep(WAIT_POLL_MS);
  }
}

/** Run the hook under the claim this open holds, leave the mark, and give the claim back either way. */
function runClaimedHook(
  port: OnHostWithHooks,
  path: string,
  hook: string,
  mark: string,
  claim: string,
): void {
  port.host.log(`… running ${HOOKS_DIR}/create`);
  try {
    port.runHook(port.host, path, hook, `${claim}/hook`);
  } catch (error) {
    releaseHookClaim(port, claim);
    throw new OrcaError(
      `${error instanceof Error ? error.message : String(error)}; fix the hook and open the workspace again, which runs it again`,
    );
  }
  const written = port.host.run([
    "sh",
    "-c",
    `printf ok > ${shellQuote(mark)}`,
  ]);
  releaseHookClaim(port, claim);
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
 * The hook runs through the port's hook runner (the Orca workspace tool's
 * runs it on this machine under the Herdr tool's supervisor, which ends it
 * and its children when it fails or outlives its limit). True when this run
 * ran it.
 */
export function ensureCreateHook(
  port: OnHostWithHooks,
  path: string,
  dir: string,
): boolean {
  const hook = hookOf(port, path, "create");
  if (hook === null) return false;
  const mark = `${dir}/${CREATE_HOOK_MARK}`;
  const claim = `${dir}/${CREATE_HOOK_CLAIM}`;
  if (awaitHookClaim(port, hook, mark, claim)) return false;
  runClaimedHook(port, path, hook, mark, claim);
  return true;
}

/**
 * The stops a drive recovers from without a person: a pass killed at its
 * deadline, and a stall that gets one more round before it stops.
 *
 * A pass killed at its deadline is not rolled back, so the driver runs the
 * two checks the stop used to ask a person to run (uncommitted edits,
 * unpushed commits) and leaves both in the tree for the next pass, which is
 * told what it inherits. The same probes name what a failed pass left, and
 * measure the tree before every gate (`unpushed.ts`). A stall gets one more
 * round with the stand-down diagnostics in the pass's notice; the stop that
 * follows names what the passes recorded deciding in the handoff narrative.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { shellQuote } from "./../cli.ts";

import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  helperTimeoutSeconds,
  run,
  runInlineProbe,
  tsArgv,
  unconcludedGitOpMarker,
} from "./../proc.ts";

import {
  unpushedBase,
  unpushedCountAdvice,
  unpushedRange,
} from "./../driven-branch.ts";

import { readPrState } from "./../pr-state.ts";

import { handoffPath, NARRATIVE_MARKER } from "./../state/handoff.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { driveState } from "./paths.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { parseJson, recordDriveEvent } from "./rearm.ts";

/**
 * Admit one more pass-deadline restart within `budget`, counting it in the
 * drive state only when it is admitted, so a deadline that stops the drive is
 * never recorded as a restart taken. Returns the restarts taken, with this
 * one when admitted; `null` when the count could not be read or recorded.
 */
export async function admitDeadlineRestart(
  pr: string,
  budget: number,
): Promise<{ admitted: boolean; taken: number } | null> {
  const got = await run(tsArgv(driveState, ["get", pr]), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (got.code !== 0) return null;
  const state = parseJson(got.stdout, "drive-state.ts get");
  if (!isRecord(state)) return null;
  const taken = state.deadlineRetries ?? 0;
  if (typeof taken !== "number" || !Number.isSafeInteger(taken)) return null;
  if (taken >= budget) return { admitted: false, taken };
  const bumped = await bumpDeadlineRetries(pr);
  if (bumped === null) return null;
  await recordDriveEvent(pr, "restart", "pass-deadline");
  return { admitted: true, taken: bumped };
}

/**
 * Count one more pass-deadline restart in the drive state and return the
 * drive's total; `null` when it could not be recorded.
 */
async function bumpDeadlineRetries(pr: string): Promise<number | null> {
  const res = await run(
    tsArgv(driveState, ["deadline-retries", pr, "--set", "bump"]),
    { stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  const n = Number.parseInt(res.stdout.trim(), 10);
  return res.code === 0 && Number.isSafeInteger(n) ? n : null;
}

/**
 * Clear the count once the drive ends (converged, or the PR closed): a later
 * drive of the same PR is a new drive. Returns whether the clear landed; on a
 * failure it prints the command that clears the count, since a count left
 * standing would spend a later drive's budget, and the caller ends the drive
 * as a failure rather than as the stop it reached.
 */
export async function clearDeadlineRetries(pr: string): Promise<boolean> {
  const argv = tsArgv(driveState, ["deadline-retries", pr, "--set", "clear"]);
  const res = await run(argv, {
    stdout: "ignore",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code === 0) return true;
  console.error(
    `drive.ts: could not clear the pass-deadline restart count (drive-state.ts exited ${res.code}); clear it before re-arming PR #${pr}: ${argv.map(shellQuote).join(" ")}`,
  );
  return false;
}

/**
 * Whether a read confirms the PR is closed or merged. A pass that exits 5 is
 * taken at its word that the PR is not open, but the restart count belongs to
 * the PR and is cleared only on a closure: an open PR keeps its budget across
 * a re-arm, and an unreadable state confirms nothing.
 */
export async function prReadsClosed(pr: string): Promise<boolean> {
  const read = await readPrState(pr, { timeoutSec: helperTimeoutSeconds() });
  if (read.ok && read.state !== "OPEN") return true;
  console.error(
    `drive.ts: PR #${pr} is not confirmed closed (${read.ok ? "it reads OPEN" : read.reason}); its restart count stays`,
  );
  return false;
}

/** What a stopped pass left in the driven tree; `null` where a probe failed. */
export interface PassLeftovers {
  /** `git status --short` lines, `''` for a clean tree. */
  uncommitted: string | null;
  /** Commits on the tree's head that the driven branch's remote ref lacks. */
  unpushed: number | null;
  /** An unconcluded merge, rebase or similar, by its marker. */
  operation: string | null;
  /** The tree's HEAD after the kill: the head the next gate may inherit. */
  head: string | null;
  /** The newest unpushed commits, `<short sha> <subject>` each. */
  commits: string[] | null;
  /** Whether HEAD contains the driven branch's remote ref. */
  onRemote: boolean | null;
  /**
   * Whether the ref the commits are counted against exists: `false` only when
   * git confirms it absent (no upstream and no attach), never for a probe
   * that failed.
   */
  baseExists: boolean | null;
  /**
   * The edits by content: the status lines and a digest of the staged diff,
   * the unstaged diff and every untracked file's content of the tree, each
   * checked-out submodule and each untracked nested repository, with the
   * HEAD of each nested one, so an edit to a file already shown as modified,
   * or a commit inside a nested repository, changes it; a commit on the
   * tree's own head does not. `''` for a clean tree.
   */
  edits: string | null;
}

/** How many unpushed commits the leftovers name one by one. */
const LISTED_COMMITS = 20;

/**
 * What the pass left in the tree. `fingerprint: false` skips the content
 * digest of the edits (`edits` is then `null`), for a report that only lists
 * them: the digest reads every untracked file and nested repository.
 */
export async function passLeftovers({
  fingerprint = true,
}: {
  fingerprint?: boolean;
} = {}): Promise<PassLeftovers> {
  const anchor = process.env.DRIVE_PR_WORKTREE;
  const opts = {
    stderr: "ignore" as const,
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
    ...(anchor ? { cwd: anchor } : {}),
  };
  // Explicit scope, as the convergence worktree check uses: a configured
  // `status.showUntrackedFiles=no` or submodule `ignore` would otherwise hide
  // an untracked fix or a modified submodule from the report.
  const status = await git(
    [
      "status",
      "--short",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    opts,
  );
  const count = await git(["rev-list", "--count", unpushedRange()], opts);
  const log = await git(
    [
      "log",
      "--no-decorate",
      "--format=%h %s",
      `--max-count=${LISTED_COMMITS}`,
      unpushedRange(),
    ],
    opts,
  );
  // Exit 1 is git's "not an ancestor"; anything else is a probe that failed.
  const based = await git(
    ["merge-base", "--is-ancestor", unpushedBase(), "HEAD"],
    opts,
  );
  const base = await git(
    ["rev-parse", "--verify", "--quiet", `${unpushedBase()}^{commit}`],
    opts,
  );
  const head = await git(["rev-parse", "HEAD"], opts);
  const op = await unconcludedGitOpMarker(gitCallTimeoutSeconds(), {
    ...(anchor ? { cwd: anchor } : {}),
    env: gitIdentityEnv(),
  });
  const uncommitted = status.code === 0 ? status.stdout.trimEnd() : null;
  return leftoversOf({
    uncommitted,
    edits: fingerprint ? await editsOf(uncommitted, opts) : null,
    count,
    log,
    based,
    base,
    head,
    op,
  });
}

/** The probes' answers as a `PassLeftovers`; a probe that failed reads `null`. */
function leftoversOf(p: {
  uncommitted: string | null;
  edits: string | null;
  count: Awaited<ReturnType<typeof git>>;
  log: Awaited<ReturnType<typeof git>>;
  based: Awaited<ReturnType<typeof git>>;
  base: Awaited<ReturnType<typeof git>>;
  head: Awaited<ReturnType<typeof git>>;
  op: Awaited<ReturnType<typeof unconcludedGitOpMarker>>;
}): PassLeftovers {
  const unpushed = Number.parseInt(p.count.stdout.trim(), 10);
  const tri = (r: Awaited<ReturnType<typeof git>>) =>
    r.code === 0 ? true : r.code === 1 ? false : null;
  return {
    uncommitted: p.uncommitted,
    edits: p.edits,
    baseExists: tri(p.base),
    unpushed: p.count.code === 0 && Number.isFinite(unpushed) ? unpushed : null,
    operation: p.op.ok ? p.op.marker : null,
    head:
      p.head.code === 0 && p.head.stdout.trim() !== ""
        ? p.head.stdout.trim()
        : null,
    commits:
      p.log.code === 0
        ? p.log.stdout.split("\n").filter((l) => l !== "")
        : null,
    onRemote: tri(p.based),
  };
}

/**
 * The edits in the tree by content (`PassLeftovers.edits`): `status` and a
 * digest of the staged diff, the unstaged diff and the untracked files'
 * contents, of the tree and of every checked-out submodule within it. `null`
 * when any probe fails, so a changed edit is never read as the same one.
 */
async function editsOf(
  status: string | null,
  opts: Parameters<typeof git>[1],
): Promise<string | null> {
  if (status === null || status === "") return status;
  const top = await git(["rev-parse", "--show-toplevel"], opts);
  const root = top.stdout.trim();
  if (top.code !== 0 || root === "") return null;
  const hash = createHash("sha256");
  if (!(await digestTree(root, opts, hash, false))) return null;
  return `${status}\n${hash.digest("hex")}`;
}

/**
 * Feed one tree's edits into `hash`, then each checked-out submodule's and
 * each untracked nested repository's, with that repository's HEAD. The
 * superproject's diff shows a dirty submodule only as its gitlink and a dirty
 * mark, and lists an untracked nested repository only by its directory, so a
 * commit or a further edit inside either is read from that repository itself.
 * The driven tree's own HEAD stays out (`withHead` false): its commits are
 * counted as unpushed work, and a commit beside edits it leaves untouched
 * does not change those edits.
 * Text conversion is off: a converter may leave out the bytes an edit changed.
 */
async function digestTree(
  dir: string,
  opts: Parameters<typeof git>[1],
  hash: ReturnType<typeof createHash>,
  withHead: boolean,
): Promise<boolean> {
  const at = { ...opts, cwd: dir };
  const diff = [
    "--binary",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules=none",
  ];
  const staged = await git(["diff", "--cached", ...diff], at);
  const unstaged = await git(["diff", ...diff], at);
  const untracked = await git(
    ["ls-files", "-z", "--others", "--exclude-standard"],
    at,
  );
  // Exit 1 is an unborn HEAD, which has no commit to record.
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], at);
  const submodules = await checkedOutSubmodules(dir, at);
  if (
    [staged, unstaged, untracked].some((r) => r.code !== 0) ||
    head.code > 1 ||
    submodules === null
  )
    return false;
  const untrackedPaths = untracked.stdout.split("\0").filter((p) => p !== "");
  const blobs = await probeEntries(
    "digest",
    untrackedPaths.map((p) => join(dir, p)).join("\0"),
  );
  // Git lists an untracked nested repository as its directory, `path/`.
  const dirs = untrackedPaths
    .filter((p) => p.endsWith("/"))
    .map((p) => join(dir, p));
  const listed =
    dirs.length === 0 ? "" : await probeEntries("checked-out", dirs.join("\0"));
  if (blobs === null || listed === null) return false;
  const nested = listed.split("\0").filter((p) => p !== "");
  for (const part of [
    dir,
    withHead ? head.stdout.trim() : "",
    staged.stdout,
    unstaged.stdout,
    untracked.stdout,
  ])
    hash.update(part).update("\0");
  hash.update(blobs).update("\0");
  for (const sub of [...submodules, ...nested])
    if (!(await digestTree(sub, opts, hash, true))) return false;
  return true;
}

/**
 * The checked-out submodules of the tree at `dir`, as absolute paths; `null`
 * when the index cannot be read. A submodule never checked out holds no edits.
 */
async function checkedOutSubmodules(
  dir: string,
  opts: Parameters<typeof git>[1],
): Promise<string[] | null> {
  const index = await git(["ls-files", "-z", "--stage"], opts);
  if (index.code !== 0) return null;
  // `<mode> <object> <stage>\t<path>`; a conflicted gitlink lists once a stage.
  const paths = new Set<string>();
  for (const entry of index.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab >= 0 && entry.startsWith("160000 "))
      paths.add(join(dir, entry.slice(tab + 1)));
  }
  if (paths.size === 0) return [];
  const listed = await probeEntries("checked-out", [...paths].join("\0"));
  return listed === null ? null : listed.split("\0").filter((p) => p !== "");
}

/**
 * The filesystem reads behind the fingerprint, in a child process with a
 * deadline: a stalled filesystem (a submodule on a network mount, say) then
 * ends one probe instead of blocking the driver's event loop, its round loop
 * and its lock heartbeat. Paths arrive NUL-separated on stdin, so a name
 * holding a newline stays one name.
 *
 * `digest`: a SHA-256 over each path, its type and what Git would commit for
 * it, read without following links: a symbolic link's target text (a
 * dangling one included), a file's bytes (read through a fixed buffer, so a
 * large file costs no more memory than a small one) and executable bit, a
 * directory (an untracked nested repository, whose own HEAD and edits the
 * caller reads) as itself. A path gone since Git listed it is recorded as
 * gone. `checked-out`: the paths holding a `.git`: a submodule that is checked
 * out, or a directory that is a repository of its own.
 */
const ENTRY_PROBE_SCRIPT = `
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const mode = process.argv[1];
const paths = fs.readFileSync(0, 'utf8').split('\\0').filter((p) => p !== '');
if (mode === 'checked-out') {
  process.stdout.write(paths.filter((p) => fs.existsSync(p + '/.git')).join('\\0'));
  process.exit(0);
}
const hash = createHash('sha256');
const field = (b) => hash.update(String(Buffer.byteLength(b)) + ':').update(b);
const buf = Buffer.alloc(1 << 16);
const contentOf = (p) => {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
};
for (const p of paths) {
  field(p);
  let s;
  try {
    s = fs.lstatSync(p);
  } catch (e) {
    if (e && e.code === 'ENOENT') { field('gone'); continue; }
    throw e;
  }
  if (s.isSymbolicLink()) { field('link'); field(fs.readlinkSync(p, 'buffer')); }
  else if (s.isFile()) { field(s.mode & 0o111 ? 'exec' : 'file'); field(contentOf(p)); }
  else if (s.isDirectory()) field('dir');
  else field('other');
}
process.stdout.write(hash.digest('hex'));
`;

/** `paths` are absolute: the probe runs from a neutral directory. */
async function probeEntries(
  mode: "digest" | "checked-out",
  paths: string,
): Promise<string | null> {
  const probe = await runInlineProbe(ENTRY_PROBE_SCRIPT, [mode], {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
    stdin: paths,
  });
  return probe.code === 0 ? probe.stdout : null;
}

/**
 * The head the next gate is told the killed pass left work on
 * (`drive-status.ts --inherited-head`): the witnessed HEAD, unless the probes
 * show nothing unpushed and nothing uncommitted. Ahead of the PR head the
 * gate accepts it in place of head lag; on the PR head itself (uncommitted
 * edits only) it still owes the round that settles them, so neither case
 * converges before a pass has run. The gate checks it still is HEAD and
 * descends from the PR head.
 */
export function inheritedHeadOf(l: PassLeftovers): string {
  const leftWork = l.unpushed !== 0 || l.uncommitted !== "";
  return l.head !== null && leftWork ? l.head : "";
}

/** The leftovers as lines for the driver log and the pass notice. */
export function describeLeftovers(l: PassLeftovers): string[] {
  const lines: string[] = [];
  if (l.uncommitted === null)
    lines.push("Uncommitted edits: could not be read (`git status` failed).");
  else if (l.uncommitted === "") lines.push("Uncommitted edits: none.");
  else
    lines.push(
      "Uncommitted edits (git status --short):",
      ...l.uncommitted.split("\n").map((line) => `  ${line}`),
    );
  lines.push(
    l.unpushed === null
      ? `Unpushed commits: could not be counted (${unpushedRange()}).`
      : `Unpushed commits: ${l.unpushed} (${unpushedRange()}).`,
  );
  if (l.unpushed !== null && l.unpushed > 0 && l.commits !== null) {
    lines.push(...l.commits.map((c) => `  ${c}`));
    if (l.unpushed > l.commits.length)
      lines.push(`  … and ${l.unpushed - l.commits.length} more`);
  }
  if (l.operation !== null)
    lines.push(`An unconcluded git operation is open: ${l.operation}.`);
  return lines;
}

/**
 * Print what the pass left in the tree to the driver's stderr under
 * `heading`: the stop line of a drive that ends without restarting, so the
 * reader learns whether work was stranded without running git themselves.
 */
export async function reportPassLeftovers(heading: string): Promise<void> {
  console.error(`  ${heading}`);
  const leftovers = await passLeftovers({ fingerprint: false });
  for (const line of describeLeftovers(leftovers)) console.error(`  ${line}`);
  // A detached tree under `DRIVE_PR_ATTACH=off` has no `@{u}` to count over:
  // name the range or the check that works there.
  if (leftovers.unpushed === null)
    console.error(
      `  Count them with ${await unpushedCountAdvice(git, process.cwd(), {
        timeoutSec: gitCallTimeoutSeconds(),
      })}.`,
    );
}

/** The notice the pass after a killed one reads in `$DRIVE_PR_PASS_NOTICE`. */
export function deadlineNotice(
  round: number,
  deadlineSec: number,
  leftovers: PassLeftovers,
): string {
  const inherited = inheritedHeadOf(leftovers);
  return [
    `RESTARTED AFTER A PASS DEADLINE: the pass on round ${round} ran past its ${deadlineSec}s deadline and was killed.`,
    "Nothing it did was rolled back. What it left in this tree:",
    ...describeLeftovers(leftovers),
    "Start from that state: finish, validate and push what is sound, discard what is not on purpose, then triage as usual.",
    ...(inherited === ""
      ? []
      : [
          `This pass inherits the killed pass's work at local HEAD ${inherited}. Run the § 1 gate with \`--inherited-head ${inherited}\`: without it the gate reads unpushed commits as HEAD_LAG, and can read a tree with only uncommitted edits as converged. Push what is sound through finish-round like any fix of this round.`,
        ]),
  ].join("\n");
}

/** The notice the extra round after a stall reads in `$DRIVE_PR_PASS_NOTICE`. */
export function stallNotice(diagnostics: string[]): string {
  return [
    "STALLED: the last passes changed nothing this driver can observe. This is the one extra round before the drive stops.",
    ...diagnostics.map((line) => line.trim()),
    "Act on the open work, or, if you decide not to, write one paragraph at the end of the handoff narrative saying what you decided and why: the stop prints it.",
  ].join("\n");
}

/**
 * The last lines the passes wrote under the handoff file's narrative marker:
 * what they recorded deciding. Empty when there is no narrative to read.
 */
export async function recordedDecisions(
  pr: string,
  maxLines = 12,
): Promise<string[]> {
  let text: string;
  try {
    const path = await handoffPath(pr);
    if (!existsSync(path)) return [];
    text = readFileSync(path, "utf8");
  } catch (err) {
    swallow(err, "the handoff file could not be read");
    return [];
  }
  const lines = text.split("\n");
  const at = lines.indexOf(NARRATIVE_MARKER);
  if (at === -1) return [];
  return (
    lines
      .slice(at + 1)
      .map((line) => line.trimEnd())
      // The resume line the handoff writer appends is its own, not a pass's.
      .filter(
        (line) =>
          line.trim() !== "" &&
          !/^\*\*Resume:\*\* `\/drive-pr \d+`$/.test(line),
      )
      .slice(-maxLines)
  );
}

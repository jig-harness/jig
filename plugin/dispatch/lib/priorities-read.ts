/**
 * The repository's priorities record as its default branch holds it, read
 * from the checkout's remote-tracking branch (`origin/<default>`) with local
 * git, so the tick sends no outside call for it. The newest revision that
 * changed `.config/priorities.yaml` is the record; when it does not validate,
 * it blocks objective allocation and the last valid revision before it is
 * reported with its age. A repository with no record ranks with no
 * objectives: urgent and bug work still rank.
 */
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../shared/guarded-git-spawn.ts";
import {
  isOwnReferenceProblem,
  parsePrioritiesRecord,
  type PrioritiesRecord,
  PRIORITIES_FILE,
  referenceProblems,
} from "../../shared/priorities/record.ts";
import { currentMs, parseMs } from "../../shared/time.ts";

/** How many earlier revisions of the file are tried for the last valid one. */
const HISTORY = 20;
const GIT_TIMEOUT_MS = 10_000;

export interface PrioritiesRecordRead {
  /** The record allocation uses; `null` when there is none or the newest is blocked. */
  record: PrioritiesRecord | null;
  /** Where it was read from (`origin/main@<sha>`), or that there is none. */
  source: string;
  /** Why the newest revision blocks allocation; `null` when it does not. */
  blocked: string | null;
  /** The last valid revision before a blocked one, shown with its age. */
  lastValid: { revision: number; commit: string; ageDays: number } | null;
  /** Whether git answered: `false` when the history or the newest revision could not be read, so an absent record is no evidence of none. */
  complete: boolean;
}

/**
 * Read the record for the checkout at `path` from `origin/<defaultBranch>`.
 * The whole read stops at `deadlineMs` (epoch milliseconds, the tick's own):
 * each git call is bounded by what is left, and a read that runs out says it
 * is incomplete rather than that there is no record.
 */
export function readRepositoryRecord(
  path: string,
  defaultBranch: string,
  nowMs: number,
  deadlineMs?: number,
): PrioritiesRecordRead {
  const git = (cwd: string, args: string[]) => run(cwd, args, deadlineMs);
  const readAt = (p: string, sha: string) => readAtWith(git, p, sha);
  const ref = `origin/${defaultBranch}`;
  const log = git(path, [
    "log",
    `-n${HISTORY}`,
    "--format=%H %cI",
    ref,
    "--",
    PRIORITIES_FILE,
  ]);
  if (!log.ok)
    return {
      record: null,
      source: `${ref} could not be read: ${log.why}`,
      blocked: null,
      lastValid: null,
      complete: false,
    };
  const commits = log.stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [sha = "", at = ""] = l.split(" ");
      return { sha, at };
    });
  const head = commits[0];
  if (head === undefined)
    return {
      record: null,
      source: `no ${PRIORITIES_FILE} on ${ref}`,
      blocked: null,
      lastValid: null,
      complete: true,
    };
  const newest = readAt(path, head.sha);
  if (newest === null)
    return {
      record: null,
      source: `no ${PRIORITIES_FILE} on ${ref}`,
      blocked: null,
      lastValid: null,
      complete: true,
    };
  if ("unread" in newest)
    return {
      record: null,
      source: `${PRIORITIES_FILE} at ${ref}@${head.sha.slice(0, 12)} could not be read: ${newest.unread}`,
      blocked: null,
      lastValid: null,
      complete: false,
    };
  if (newest.ok)
    return {
      record: newest.record,
      source: `${ref}@${head.sha.slice(0, 12)}`,
      blocked: null,
      lastValid: null,
      complete: true,
    };
  const blocked = `the newest revision of ${PRIORITIES_FILE} (${head.sha.slice(0, 12)}) is infeasible and blocks objective allocation: ${newest.why}`;
  let history = true;
  for (const c of commits.slice(1)) {
    const earlier = readAt(path, c.sha);
    if (earlier !== null && "unread" in earlier) history = false;
    if (earlier !== null && "ok" in earlier && earlier.ok)
      return {
        record: null,
        source: `${ref}@${head.sha.slice(0, 12)}`,
        blocked,
        lastValid: {
          revision: earlier.record.revision,
          commit: c.sha.slice(0, 12),
          ageDays: Math.max(
            0,
            Math.floor((nowMs - parseMs(c.at)) / 86_400_000),
          ),
        },
        complete: true,
      };
  }
  return {
    record: null,
    source: `${ref}@${head.sha.slice(0, 12)}`,
    blocked,
    lastValid: null,
    complete: history,
  };
}

/**
 * The record at `sha`: parsed, invalid with why, `null` when the commit holds
 * no such file (it removed it), or `unread` with git's failure.
 */
function readAtWith(
  git: GitRun,
  path: string,
  sha: string,
):
  | { ok: true; record: PrioritiesRecord }
  | { ok: false; why: string }
  | { unread: string }
  | null {
  const shown = git(path, ["show", `${sha}:${PRIORITIES_FILE}`]);
  if (!shown.ok) {
    const listed = git(path, [
      "ls-tree",
      "--name-only",
      sha,
      "--",
      PRIORITIES_FILE,
    ]);
    return listed.ok && listed.stdout.trim() === ""
      ? null
      : { unread: shown.why };
  }
  const parsed = parsePrioritiesRecord(shown.stdout);
  if (!parsed.ok) return { ok: false, why: parsed.failure.reason };
  if (parsed.value.level !== "repository")
    return {
      ok: false,
      why: `its level is ${parsed.value.level}, not repository`,
    };
  // A repository record's references to other levels or scopes resolve only
  // when those records are read; the host reads none, so they are not required.
  const own = referenceProblems([parsed.value]).filter((p) =>
    isOwnReferenceProblem(p, parsed.value),
  );
  return own.length > 0
    ? { ok: false, why: own.map((p) => p.text).join("; ") }
    : { ok: true, record: parsed.value };
}

type GitRun = (
  cwd: string,
  args: string[],
) => { ok: true; stdout: string } | { ok: false; why: string };

/** A git command's output, or why it failed: its last line of error output, or that it timed out or the tick's time was spent. */
function run(
  cwd: string,
  args: string[],
  deadlineMs: number | undefined,
): { ok: true; stdout: string } | { ok: false; why: string } {
  const left = deadlineMs === undefined ? Infinity : deadlineMs - currentMs();
  if (left < 1)
    return {
      ok: false,
      why: `git ${args[0]} not run: the tick's time is spent`,
    };
  const r = spawnSync("git", args, {
    cwd,
    timeout: Math.min(GIT_TIMEOUT_MS, Math.floor(left)),
    env: withoutLeakyGitEnv(process.env),
  });
  if (r.status === 0) return { ok: true, stdout: r.stdout };
  if (r.error !== undefined)
    return { ok: false, why: `git ${args[0]}: ${r.error.message}` };
  if (r.signal !== null)
    return {
      ok: false,
      why: `git ${args[0]} did not finish within ${GIT_TIMEOUT_MS / 1000}s (${r.signal})`,
    };
  const last = (r.stderr ?? "").trim().split("\n").at(-1)?.trim();
  return {
    ok: false,
    why: `git ${args[0]} exited ${r.status}${last ? `: ${last}` : ""}`,
  };
}

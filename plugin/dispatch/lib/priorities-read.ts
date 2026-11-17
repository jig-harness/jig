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
  parsePrioritiesRecord,
  type PrioritiesRecord,
  PRIORITIES_FILE,
  referenceProblems,
} from "../../shared/priorities/record.ts";
import { parseMs } from "../../shared/time.ts";

/** How many earlier revisions of the file are tried for the last valid one. */
const HISTORY = 20;
const GIT_TIMEOUT_MS = 10_000;

export interface RecordRead {
  /** The record allocation uses; `null` when there is none or the newest is blocked. */
  record: PrioritiesRecord | null;
  /** Where it was read from (`origin/main@<sha>`), or that there is none. */
  source: string;
  /** Why the newest revision blocks allocation; `null` when it does not. */
  blocked: string | null;
  /** The last valid revision before a blocked one, shown with its age. */
  lastValid: { revision: number; commit: string; ageDays: number } | null;
}

/** Read the record for the checkout at `path` from `origin/<defaultBranch>`. */
export function readRepositoryRecord(
  path: string,
  defaultBranch: string,
  nowMs: number,
): RecordRead {
  const ref = `origin/${defaultBranch}`;
  const log = git(path, [
    "log",
    `-n${HISTORY}`,
    "--format=%H %cI",
    ref,
    "--",
    PRIORITIES_FILE,
  ]);
  if (log === null)
    return {
      record: null,
      source: `${ref} could not be read`,
      blocked: null,
      lastValid: null,
    };
  const commits = log
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
    };
  const newest = readAt(path, head.sha);
  if (newest === null)
    return {
      record: null,
      source: `no ${PRIORITIES_FILE} on ${ref}`,
      blocked: null,
      lastValid: null,
    };
  if (newest.ok)
    return {
      record: newest.record,
      source: `${ref}@${head.sha.slice(0, 12)}`,
      blocked: null,
      lastValid: null,
    };
  const blocked = `the newest revision of ${PRIORITIES_FILE} (${head.sha.slice(0, 12)}) is infeasible and blocks objective allocation: ${newest.why}`;
  for (const c of commits.slice(1)) {
    const earlier = readAt(path, c.sha);
    if (earlier?.ok === true)
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
      };
  }
  return {
    record: null,
    source: `${ref}@${head.sha.slice(0, 12)}`,
    blocked,
    lastValid: null,
  };
}

function readAt(
  path: string,
  sha: string,
): { ok: true; record: PrioritiesRecord } | { ok: false; why: string } | null {
  const text = git(path, ["show", `${sha}:${PRIORITIES_FILE}`]);
  if (text === null) return null;
  const parsed = parsePrioritiesRecord(text);
  if (!parsed.ok) return { ok: false, why: parsed.failure.reason };
  if (parsed.value.level !== "repository")
    return {
      ok: false,
      why: `its level is ${parsed.value.level}, not repository`,
    };
  // A repository record's references to other levels resolve only when those
  // records are read; the host reads none, so they are reported, not required.
  const own = referenceProblems([parsed.value]).filter((p) =>
    p.includes("repository:"),
  );
  return own.length > 0
    ? { ok: false, why: own.join("; ") }
    : { ok: true, record: parsed.value };
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: withoutLeakyGitEnv(process.env),
  });
  return r.status === 0 ? r.stdout : null;
}

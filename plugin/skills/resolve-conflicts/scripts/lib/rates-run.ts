/**
 * `history.ts --rates`: the merged-pull-request cohort read from the forge
 * (`cohort.ts`), the merges replayed and the live conflict record read, as
 * the report reads them, and the rates (`rates.ts`) built from them and
 * written. A cohort that does not read in full writes nothing, so a rates
 * file already at `--out` stays as it was.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { errnoCode, swallow } from "../../../../shared/errors.ts";
import { isoFromMs, parseMs } from "../../../../shared/time.ts";
import {
  type Ancestry,
  ancestryFrom,
  type ConflictEvidence,
  type LiveEvent,
  liveEvent,
} from "../../../drive-pr/scripts/lib/fractal-conflicts.ts";
import { type AskCohortPage, type CohortPr, readCohort } from "./cohort.ts";
import { eventsPath } from "./events.ts";
import { splitNul } from "./git.ts";
import { buildRates, type FirstParent, type Rates } from "./rates.ts";
import { Git, ReplayError } from "./replay.ts";
import type { MergeRecord, Range, SkippedMerge } from "./report.ts";

const DAY_MS = 86_400_000;

/**
 * How far before the window the replay reaches for the history of the
 * cohort's pull requests: a branch opened earlier than that has the merges
 * of its first weeks unreplayed, and stays unknown unless a conflict is
 * found.
 */
export const REPLAY_LOOKBACK_MS = 30 * DAY_MS;

/** The exit of a cohort that did not read in full: nothing was written. */
export const COHORT_UNREAD_EXIT = 3;

const OID = /^[0-9a-f]{40,64}$/;

/**
 * git's answers to a commit or object the clone does not hold: the expected
 * "unavailable". A diagnostic that says anything else (a corrupt object, a
 * denied read) is an operational failure, so an answer is "unavailable" only
 * when every `fatal:` or `error:` line of it is one of these.
 */
const MISSING_OBJECT_LINE =
  /^(?:fatal|error): (?:bad object|bad revision|ambiguous argument|unknown revision|not a valid object name|invalid revision|needed a single revision|unable to read tree)\b/i;

/** `git` that never fetches a missing object of a partial clone: a rates read stays inside the clone. */
function withoutLazyFetch(git: Git): Git {
  return new Git(git.cwd, { ...git.env, GIT_NO_LAZY_FETCH: "1" }, git.settings);
}

/** git's exit, as the object it asked for being unavailable (true), or as a failure to report (throws). */
export function unavailable(
  args: readonly string[],
  r: {
    code: number;
    stderr: string;
  },
): true {
  const diagnostics = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(?:fatal|error):/i.test(l));
  if (
    diagnostics.length > 0 &&
    diagnostics.every((l) => MISSING_OBJECT_LINE.test(l))
  )
    return true;
  throw new ReplayError(
    `git ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`,
  );
}

/** The integration branch as the clone holds it: its remote-tracking ref on `remote` first, else the local branch; null when neither exists. */
export function integrationRef(
  git: Git,
  remote: string,
  branch: string | null,
): string | null {
  if (branch === null) return null;
  for (const ref of [
    `refs/remotes/${remote}/${branch}`,
    `refs/heads/${branch}`,
  ]) {
    const r = git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r.code === 0) return ref;
  }
  return null;
}

/** The first-parent commits of `ref` whose committer time falls in `[since, until)` (seconds; null is open), newest first. */
export function firstParents(
  git: Git,
  ref: string,
  since: number | null,
  until: number | null,
): FirstParent[] {
  const out = git.text([
    "log",
    "--no-show-signature",
    "--first-parent",
    "-z",
    ...(since === null ? [] : [`--since-as-filter=${isoFromMs(since * 1000)}`]),
    "--format=%H%x1f%P%x1f%ct%x1f%at%x1f%s",
    ref,
  ]);
  return splitNul(out).flatMap((record) => {
    const [commit = "", parents = "", ct = "", at = "", subject = ""] =
      record.split("\x1f");
    const time = Number(ct);
    if (
      commit === "" ||
      (since !== null && time < since) ||
      (until !== null && time >= until)
    )
      return [];
    return [
      {
        commit,
        parents: parents.split(" ").filter((p) => p !== ""),
        subject,
        authorTime: Number(at),
      },
    ];
  });
}

/**
 * A pull request's own history, as M11 reads it: its head's first-parent
 * commits not reachable from its merge commit's first parent, and the merge
 * commit itself; null when the clone holds neither its head nor its merge.
 */
export function ancestryOf(git: Git, pr: CohortPr): Ancestry {
  const { headRefOid: head, mergeCommit: merge } = pr;
  if (head === null || merge === null || !OID.test(head) || !OID.test(merge))
    return null;
  const landedArgs = ["rev-list", "--parents", "-n", "1", merge];
  const landed = git.raw(landedArgs);
  if (landed.code !== 0) return unavailable(landedArgs, landed) && null;
  const final = landed.stdout.toString("utf8").trim().split(" ");
  if (final.length < 2) return null;
  const listedArgs = [
    "rev-list",
    "--first-parent",
    "--parents",
    head,
    `^${final[1]}`,
  ];
  const listed = git.raw(listedArgs);
  if (listed.code !== 0) return unavailable(listedArgs, listed) && null;
  return ancestryFrom(listed.stdout.toString("utf8"), final);
}

/** The files a commit changed against its first parent, both names of a rename; null when the clone cannot tell. */
export function commitFiles(git: Git, commit: string): string[] | null {
  const args = [
    "diff-tree",
    "-r",
    "-z",
    "--name-only",
    "--no-renames",
    `${commit}^`,
    commit,
  ];
  const r = git.raw(args);
  if (r.code === 0) return splitNul(r.stdout.toString("utf8"));
  return unavailable(args, r) && null;
}

/**
 * The clone's live conflict events; `complete` is false when the record is
 * there but does not read. A clone with no record has no live evidence.
 */
export function readLiveEvents(root: string): {
  events: LiveEvent[];
  complete: boolean;
} {
  let lines: string;
  try {
    lines = readFileSync(eventsPath(root), "utf8");
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return { events: [], complete: true };
    swallow(
      err,
      "an unreadable live record leaves no pull request observed clean",
    );
    return { events: [], complete: false };
  }
  const events: LiveEvent[] = [];
  for (const line of lines.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!liveEvent(parsed)) return { events, complete: false };
      events.push(parsed);
    } catch (err) {
      swallow(err, "a line that is not JSON leaves the live record incomplete");
      return { events, complete: false };
    }
  }
  return { events, complete: true };
}

/** Where the replay starts: the window's start, or the cohort's earliest branch time within `REPLAY_LOOKBACK_MS` before it. */
export function replayStart(
  prs: readonly CohortPr[],
  since: number | null,
): number | null {
  if (since === null) return null;
  let earliest = since;
  for (const pr of prs)
    for (const t of [pr.createdAt, ...pr.commits.map((c) => c.committedAt)]) {
      const ms = parseMs(t);
      if (ms < earliest) earliest = ms;
    }
  return Math.max(earliest, since - REPLAY_LOOKBACK_MS);
}

/** Write `text` to `path` through a temporary file renamed into place, so a reader never sees half of it. */
export function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function readJson(path: string | null): unknown {
  if (path === null) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    swallow(err, "a kept listing that does not read is listed again in full");
    return null;
  }
}

export interface Replayed {
  merges: MergeRecord[];
  skipped: SkippedMerge[];
  shallow: boolean;
}

export interface RatesRun {
  git: Git;
  /** The working tree's root, whose clone holds the live record. */
  root: string;
  /** The consumer's remote (`repository.remote`), whose tracking branch is the integration history. */
  remote: string;
  range: Range;
  /** The window, milliseconds since the epoch; null is open. */
  since: number | null;
  until: number | null;
  now: number;
  /** Where the rates are written; null prints them. */
  out: string | null;
  /** Where the cohort's listing is kept between runs; null keeps nothing. */
  cachePath: string | null;
  ask: AskCohortPage;
  /** Replay the merges committed in `[since, until)` (seconds; null is open). */
  replay: (since: number | null, until: number | null) => Replayed;
}

export type RatesResult =
  | { ok: true; rates: Rates; text: string }
  | { ok: false; code: number; reason: string };

const seconds = (ms: number | null) =>
  ms === null ? null : Math.ceil(ms / 1000);

/** The rates of the window, written to `out` when it names a file; or why nothing was written. */
export async function runRates(run: RatesRun): Promise<RatesResult> {
  const cohort = await readCohort({
    since: run.since,
    until: run.until,
    now: run.now,
    cache: readJson(run.cachePath),
    ask: run.ask,
  });
  if (!cohort.ok)
    return {
      ok: false,
      code: COHORT_UNREAD_EXIT,
      reason: `the merged pull requests did not read in full (${cohort.failure.reason}); ${run.out === null ? "nothing was written" : `${run.out} is kept as it was`}`,
    };
  if (run.cachePath !== null)
    writeWhole(run.cachePath, `${JSON.stringify(cohort.value.cache)}\n`);
  const { prs } = cohort.value;
  const replayed = run.replay(
    seconds(replayStart(prs, run.since)),
    seconds(run.until),
  );
  const live = readLiveEvents(run.root);
  const evidence: ConflictEvidence = {
    report: {
      schema: "merge-conflicts/v1",
      shallow: replayed.shallow,
      merges: replayed.merges.map((m) => ({
        commit: m.commit,
        conflicted: m.conflicted,
        pullRequest: m.pullRequest,
        date: m.date,
      })),
    },
    complete: live.complete,
    events: live.events,
  };
  const git = withoutLazyFetch(run.git);
  const ref = integrationRef(git, run.remote, cohort.value.defaultBranch);
  const files = new Map<string, string[] | null>();
  const rates = buildRates({
    repository: cohort.value.repository,
    range: run.range,
    generatedAt: isoFromMs(run.now),
    prs,
    listing: cohort.value.listing,
    firstParents:
      ref === null
        ? null
        : firstParents(git, ref, seconds(run.since), seconds(run.until)),
    evidence,
    ancestry: (pr) => ancestryOf(git, pr),
    commitFiles: (commit) => {
      if (!files.has(commit)) files.set(commit, commitFiles(git, commit));
      return files.get(commit) ?? null;
    },
  });
  const text = `${JSON.stringify(rates, null, 2)}\n`;
  if (run.out !== null) writeWhole(run.out, text);
  return { ok: true, rates, text };
}

/** One line saying what a run wrote. */
export function ratesSummary(rates: Rates, out: string): string {
  const c = rates.cohort;
  return `Conflict rates, ${rates.range.label}: ${c.pullRequests} merged pull requests (${c.conflicted} conflicted, ${c.clean} clean, ${c.unknown} unknown), ${rates.paths.length} paths; written to ${out}.`;
}

/**
 * Before a follow-up whose arm stayed pending past `dispatch.followup_within`
 * goes to a person, the tick reads that arm again (`followup-waits.ts`): a
 * release tag or a deploy run is usually minutes away when the window runs
 * out. For each merged pull request whose run of waits on this host is
 * spent on a pending wait past its window that ended within `REREAD_MS`, it
 * asks whether the release tags the arm names exist, in one query for every
 * such pull request (`taggedReleases`, a point of the forge's budget), and
 * whether each workflow run the arm links to has finished, one REST request
 * per run (`finishedRuns`, at most `MAX_RUNS`). A launch record whose every
 * named tag exists and every named run finished has an arm that settled:
 * the plan runs the follow-up once more instead of raising it, and the
 * apply releases its marker. A run that finished in any conclusion but
 * `cancelled` settles the wait, and the next pass reads what it concluded;
 * a cancelled run was superseded, and leaves the follow-up to a person.
 *
 * A wait whose arm names neither a tag nor a run, one on an arm an earlier
 * run already went past its window on, one that ended longer ago, and a
 * read that fails, which leaves only the arms that need it, all leave the follow-up to a person, as its last pass
 * read it: a person's answer to the need it raised is not overtaken by a
 * later read.
 */
import { ok, type Failure, type Outcome } from "../../shared/outcome.ts";
import { parseMs } from "../../shared/time.ts";
import { waitStreak } from "./followup-waits.ts";
import { runWord, type WorkflowRun } from "./wait-for.ts";
import type { ReadRecord } from "./launches.ts";
import {
  finishedRuns,
  type RunReads,
  taggedReleases,
} from "./release-gates.ts";
import type { TickBound } from "./sources/bounded.ts";
import type { RepoTarget } from "./types.ts";

/** The most tags one re-read asks for: more are left for a person. */
const MAX_TAGS = 20;

/** The most workflow runs one re-read asks about: more are left for a person. */
const MAX_RUNS = 10;

/** How long after a spent pass ended the tick still reads its arm again: a few ticks. */
export const REREAD_MS = 15 * 60_000;

/** How the tick reads which release tags exist. */
export type TagReader = (
  repo: RepoTarget,
  tags: readonly string[],
  bound?: TickBound,
) => Promise<Outcome<Set<string>, "refused">>;

/** How the tick reads which workflow runs have finished, by `runWord`. */
export type RunReader = (
  repo: RepoTarget,
  runs: readonly WorkflowRun[],
  bound?: TickBound,
) => Promise<Outcome<RunReads, "refused">>;

/** What a re-read answered: the settled records, and a read that failed beside them. */
export interface ArmReread {
  settled: Set<string>;
  failure: Failure<"refused"> | null;
}

/** When a launch record's pass ended; `null` for one that has not, or whose end does not read. */
function endedAt(r: ReadRecord | undefined): number | null {
  if (r?.state.kind !== "ended") return null;
  const at = parseMs(r.state.exit.at);
  return Number.isFinite(at) ? at : null;
}

/**
 * The launch records of the follow-ups of `merged` whose spent pending wait
 * names release tags that all exist now and workflow runs that have all
 * finished; empty when none asks for a read.
 */
export async function rereadPendingArms(
  repo: RepoTarget,
  merged: ReadonlyArray<{ number: number }>,
  records: readonly ReadRecord[],
  nowMs: number,
  bound?: TickBound,
  read: TagReader = taggedReleases,
  readRuns: RunReader = finishedRuns,
): Promise<ArmReread> {
  const wanted = merged.flatMap((pr) => {
    const streak = waitStreak(records, repo.slug, pr.number);
    if (!streak?.spent) return [];
    if (streak.reread.length === 0 && streak.rereadRuns.length === 0) return [];
    const ended = endedAt(records.find((r) => r.record.id === streak.record));
    return ended !== null && nowMs - ended <= REREAD_MS
      ? [
          {
            record: streak.record,
            tags: streak.reread,
            runs: streak.rereadRuns,
          },
        ]
      : [];
  });
  const tags = [...new Set(wanted.flatMap((w) => w.tags))].slice(0, MAX_TAGS);
  const runs = [
    ...new Map(wanted.flatMap((w) => w.runs).map((r) => [runWord(r), r])),
  ]
    .slice(0, MAX_RUNS)
    .map(([, r]) => r);
  if (tags.length === 0 && runs.length === 0)
    return { settled: new Set(), failure: null };
  const found =
    tags.length === 0 ? ok(new Set<string>()) : await read(repo, tags, bound);
  const finished: Outcome<RunReads, "refused"> =
    runs.length === 0
      ? ok({
          finished: new Set<string>(),
          unread: new Set<string>(),
          failure: null,
        })
      : await readRuns(repo, runs, bound);
  // A read that failed leaves only the arms that need it unsettled, down to the single run a lookup missed; the arms
  // that wait on the other read keep their answer, and the failure travels
  // with them.
  const tagSet = found.ok ? found.value : new Set<string>();
  const runSet = finished.ok ? finished.value.finished : new Set<string>();
  const unread = finished.ok ? finished.value.unread : new Set<string>();
  const runsRead = (w: { runs: readonly WorkflowRun[] }) =>
    w.runs.length === 0 ||
    (finished.ok && w.runs.every((r) => !unread.has(runWord(r))));
  const settled = new Set(
    wanted
      .filter(
        (w) =>
          (found.ok || w.tags.length === 0) &&
          runsRead(w) &&
          w.tags.every((t) => tagSet.has(t)) &&
          w.runs.every((r) => runSet.has(runWord(r))),
      )
      .map((w) => w.record),
  );
  const failure = !found.ok
    ? found.failure
    : !finished.ok
      ? finished.failure
      : finished.value.failure;
  return { settled, failure };
}

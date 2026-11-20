/**
 * Before a follow-up whose arm stayed pending past `dispatch.followup_within`
 * goes to a person, the tick reads that arm again (`followup-waits.ts`): a
 * release tag is usually minutes away when the window runs out. For each
 * merged pull request whose run of waits on this host is spent on a pending
 * wait past its window that ended within `REREAD_MS`, it asks whether the
 * release tags the arm names exist, in one query for every such pull
 * request (`taggedReleases`, a point of the forge's budget). A launch
 * record whose every named tag exists has an arm that settled: the plan
 * runs the follow-up once more instead of raising it, and the apply
 * releases its marker.
 *
 * A wait whose arm names no tag, one on an arm an earlier run already went
 * past its window on, one that ended longer ago, and a read that fails all
 * leave the follow-up to a person, as its last pass read it: a person's
 * answer to the need it raised is not overtaken by a later read.
 */
import { ok, type Outcome } from "../../shared/outcome.ts";
import { parseMs } from "../../shared/time.ts";
import { waitStreak } from "./followup-waits.ts";
import type { ReadRecord } from "./launches.ts";
import { taggedReleases } from "./release-gates.ts";
import type { TickBound } from "./sources/bounded.ts";
import type { RepoTarget } from "./types.ts";

/** The most tags one re-read asks for: more are left for a person. */
const MAX_TAGS = 20;

/** How long after a spent pass ended the tick still reads its arm again: a few ticks. */
export const REREAD_MS = 15 * 60_000;

/** How the tick reads which release tags exist. */
export type TagReader = (
  repo: RepoTarget,
  tags: readonly string[],
  bound?: TickBound,
) => Promise<Outcome<Set<string>, "refused">>;

/** When a launch record's pass ended; `null` for one that has not, or whose end does not read. */
function endedAt(r: ReadRecord | undefined): number | null {
  if (r?.state.kind !== "ended") return null;
  const at = parseMs(r.state.exit.at);
  return Number.isFinite(at) ? at : null;
}

/**
 * The launch records of the follow-ups of `merged` whose spent pending wait
 * names release tags that all exist now; empty when none asks for a read.
 */
export async function rereadPendingArms(
  repo: RepoTarget,
  merged: ReadonlyArray<{ number: number }>,
  records: readonly ReadRecord[],
  nowMs: number,
  bound?: TickBound,
  read: TagReader = taggedReleases,
): Promise<Outcome<Set<string>, "refused">> {
  const wanted = merged.flatMap((pr) => {
    const streak = waitStreak(records, repo.slug, pr.number);
    if (!streak?.spent || streak.reread.length === 0) return [];
    const ended = endedAt(records.find((r) => r.record.id === streak.record));
    return ended !== null && nowMs - ended <= REREAD_MS
      ? [{ record: streak.record, tags: streak.reread }]
      : [];
  });
  const tags = [...new Set(wanted.flatMap((w) => w.tags))].slice(0, MAX_TAGS);
  if (tags.length === 0) return ok(new Set());
  const found = await read(repo, tags, bound);
  if (!found.ok) return found;
  return ok(
    new Set(
      wanted
        .filter((w) => w.tags.every((t) => found.value.has(t)))
        .map((w) => w.record),
    ),
  );
}

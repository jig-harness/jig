/**
 * Before a follow-up whose arm stayed pending past `dispatch.followup_within`
 * goes to a person, the tick reads that arm again (`followup-waits.ts`): a
 * release tag is usually minutes away when the window runs out. For each
 * merged pull request whose run of waits on this host is spent on its first
 * pending wait past the window, it asks whether the release tags the arm
 * names exist, in one query for every such pull request (`taggedReleases`,
 * a point of the forge's budget). A launch record whose every named tag
 * exists has an arm that settled: the plan runs the follow-up once more
 * instead of raising it, and the apply releases its marker.
 *
 * A wait whose arm names no tag, a second wait past its window, and a read
 * that fails all leave the follow-up to a person, as its last pass read it.
 */
import { ok, type Outcome } from "../../shared/outcome.ts";
import type { ReadRecord } from "./launches.ts";
import { taggedReleases } from "./release-gates.ts";
import type { TickBound } from "./sources/bounded.ts";
import { waitStreak } from "./followup-waits.ts";
import type { RepoTarget } from "./types.ts";

/** The most tags one re-read asks for: more are left for a person. */
const MAX_TAGS = 20;

/** How the tick reads which release tags exist. */
export type TagReader = (
  repo: RepoTarget,
  tags: readonly string[],
  bound?: TickBound,
) => Promise<Outcome<Set<string>, "refused">>;

/**
 * The launch records of the follow-ups of `merged` whose spent pending wait
 * names release tags that all exist now; empty when none asks for a read.
 */
export async function rereadPendingArms(
  repo: RepoTarget,
  merged: ReadonlyArray<{ number: number }>,
  records: readonly ReadRecord[],
  bound?: TickBound,
  read: TagReader = taggedReleases,
): Promise<Outcome<Set<string>, "refused">> {
  const wanted = merged.flatMap((pr) => {
    const streak = waitStreak(records, repo.slug, pr.number);
    return streak?.spent && streak.reread.length > 0
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

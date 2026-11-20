/**
 * The line after a tick that had no credential for a repository's tracker
 * (`no-credential.ts`). The tick read the repository's forge and sessions,
 * so its part of the line is its own, except what only the tracker says:
 * the cards and needs about items (an entry that names an item and no pull
 * request) and the claimed items an open pull request carries. Those are
 * kept from the line before, and the repository's entry is marked
 * (`trackerKept`) with the time of the last reading that had a credential
 * and what was missing, so a need or a card does not leave the line because
 * the tick could not ask.
 */
import type { LineRepo, LineSnapshot } from "./dashboard-contract.ts";
import { retainedSlug } from "./line-unread.ts";

/** Whether a part of the line comes from the tracker alone: it names an item and no pull request. */
const fromTracker = (x: { item: string | null; pr: number | null }): boolean =>
  x.item !== null && x.pr === null;

/** The reading a kept part is from: the one the entry before kept, else that entry's own. */
function lastReading(
  before: LineSnapshot,
  entry: LineRepo | undefined,
): { readAt: string | null; runId?: string } {
  if (entry === undefined) return { readAt: null };
  if (entry.trackerKept !== undefined) {
    const { reason: _reason, ...kept } = entry.trackerKept;
    return kept;
  }
  return {
    readAt: entry.readAt ?? before.startedAt,
    runId: entry.runId ?? before.runId,
  };
}

/**
 * `line`, with each repository the tick `runId` read whose tracker is one of
 * `systems` (adapter to reason) keeping its tracker part from `before`.
 */
export function keepTrackerPart(
  line: LineSnapshot,
  before: LineSnapshot | null,
  tick: {
    runId: string;
    systems: ReadonlyMap<string, string>;
    /** Per system, the only repositories (by slug) that keep their part; a system it omits keeps every one. */
    only?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): LineSnapshot {
  if (tick.systems.size === 0) return line;
  const keyless = new Map<string, string>();
  // Absent: the tracker the repository has now is not the one the line before read, so nothing carries over.
  const absent = new Set<string>();
  for (const r of line.repos) {
    const reason =
      r.tracker == null ? undefined : tick.systems.get(r.tracker.adapter);
    if (reason === undefined || r.slug === null || r.runId !== tick.runId)
      continue;
    const only = tick.only?.get(r.tracker?.adapter ?? "");
    if (only !== undefined && !only.has(r.slug)) continue;
    keyless.set(r.slug, reason);
    const was = before?.repos.find(
      (b) => b.path === r.path && retainedSlug(b) === r.slug,
    );
    if (was?.tracker != null && was.tracker.adapter !== r.tracker?.adapter)
      absent.add(r.slug);
  }
  if (keyless.size === 0) return line;
  const swap = <T extends { repo: string }>(
    now: readonly T[],
    kept: readonly T[],
    tracked: (x: T) => boolean,
  ): T[] => [
    ...now.filter((x) => !(keyless.has(x.repo) && tracked(x))),
    ...kept.filter(
      (x) => keyless.has(x.repo) && !absent.has(x.repo) && tracked(x),
    ),
  ];
  const prior = before ?? { ...line, needs: [], queue: [], carried: [] };
  return {
    ...line,
    needs: swap(line.needs, prior.needs, fromTracker),
    queue: swap(line.queue, prior.queue, fromTracker),
    carried: swap(line.carried ?? [], prior.carried ?? [], () => true),
    repos: line.repos.map((r) => {
      const reason = r.slug === null ? undefined : keyless.get(r.slug);
      if (reason === undefined) return r;
      const entry = before?.repos.find(
        (b) => b.path === r.path && retainedSlug(b) === r.slug,
      );
      const from =
        before === null || absent.has(r.slug as string)
          ? { readAt: null }
          : lastReading(before, entry);
      return { ...r, trackerKept: { ...from, reason } };
    }),
  };
}

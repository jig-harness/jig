/**
 * The line after a tick that read only some of the repositories the machine
 * file lists: another tick held the rest (busy), or a wake-up asked for a
 * few. Each repository's part of the line (its needs, its queue, its
 * sessions, its Ready cards and its own entry) comes from the newest tick
 * that read it, and the entry names that tick and when it started (`runId`,
 * `readAt`), so the page can say which part is old and why. A repository the
 * tick reported on replaces its whole part, even a report that found no
 * slug and so brought no cards. The rest belongs
 * to the whole machine (the accounts, the line's own tick and times, the
 * receipt beside it, except the recent tick durations and their maximum,
 * which every tick that reads adds its own to): a tick the timer asked for every repository writes it,
 * busy ones or not, and a wake-up for a few leaves it as it was, so a timer
 * that stopped still shows as one while woken ticks run.
 */
import type { LineSnapshot } from "./dashboard-contract.ts";
import { NEEDS_REPOSITORY_LABEL } from "./sources/served-repo.ts";

/** The line with each repository's entry marked as read by the tick `runId` that started at `at`. */
export function readBy(
  line: LineSnapshot,
  runId: string,
  at: string,
): LineSnapshot {
  return {
    ...line,
    repos: line.repos.map((r) => ({ ...r, runId, readAt: at })),
  };
}

/**
 * `fresh`, built from the repositories one tick read, with every other
 * repository's part kept from `previous`, in the machine file's order
 * (`listed`); the machine's part is `fresh`'s when the tick wrote it
 * (`machine: "fresh"`), else `previous`'s. A repository the machine file no
 * longer lists is dropped with its part; one no tick has read yet has no
 * entry.
 */
export function mergeLine(
  previous: LineSnapshot,
  fresh: LineSnapshot,
  listed: ReadonlyArray<{ path: string }>,
  machine: "fresh" | "kept",
): LineSnapshot {
  const keptPaths = new Map(previous.repos.map((r) => [r.path, r]));
  // A repository a newer tick read since this one did keeps that tick's part.
  const outdated = (r: { path: string; readAt?: string }): boolean => {
    const before = keptPaths.get(r.path);
    return (
      before !== undefined &&
      (before.readAt ?? previous.startedAt) > (r.readAt ?? fresh.startedAt)
    );
  };
  const current = fresh.repos.filter((r) => !outdated(r));
  const read = new Set(
    current.flatMap((r) => (r.slug === null ? [] : [r.slug])),
  );
  const paths = new Set(listed.map((r) => r.path));
  const freshPaths = new Map(current.map((r) => [r.path, r]));
  const kept = new Set(
    previous.repos.flatMap((r) =>
      r.slug === null ||
      !paths.has(r.path) ||
      freshPaths.has(r.path) ||
      read.has(r.slug)
        ? []
        : [r.slug],
    ),
  );
  const part = <T extends { repo: string }>(
    before: readonly T[],
    now: readonly T[],
  ): T[] => [
    ...before.filter((x) => kept.has(x.repo)),
    ...now.filter((x) => read.has(x.repo)),
  ];
  // Repositories sharing a tracker team read the same unlabelled item; a kept part's report of it stands against a wake-up's.
  const reported = new Set<string>();
  const queue = part(previous.queue, fresh.queue).filter((q) => {
    if (q.why !== NEEDS_REPOSITORY_LABEL) return true;
    if (reported.has(q.target)) return false;
    reported.add(q.target);
    return true;
  });
  const base = machine === "fresh" ? fresh : previous;
  // Whichever tick's part is kept, this tick's duration stays in the history the freshness checks take their maximum from.
  const durations =
    machine === "fresh" || fresh.recentTicksMs === undefined
      ? {}
      : {
          recentTicksMs: fresh.recentTicksMs,
          longestTickMs: Math.max(...fresh.recentTicksMs),
        };
  return {
    ...base,
    ...durations,
    ...(base.load === undefined && previous.load !== undefined
      ? { load: previous.load }
      : {}),
    sessions: part(previous.sessions, fresh.sessions),
    needs: part(previous.needs, fresh.needs),
    queue,
    ready: part(previous.ready ?? [], fresh.ready ?? []),
    repos: listed.flatMap(({ path }) => {
      const now = freshPaths.get(path);
      if (now !== undefined) return [now];
      const before = keptPaths.get(path);
      return before === undefined
        ? []
        : [
            {
              ...before,
              runId: before.runId ?? previous.runId,
              readAt: before.readAt ?? previous.startedAt,
            },
          ];
    }),
  };
}

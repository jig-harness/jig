/**
 * The line after a tick that read only some of the repositories the machine
 * file lists: another tick held the rest (busy), or a wake-up asked for a
 * few. Each repository's part of the line (its needs, its queue, its
 * sessions, its Ready cards and its own entry) comes from the newest tick
 * that read it, and the entry names that tick and when it started (`runId`,
 * `readAt`), so the page can say which part is old and why. A repository the
 * tick read replaces its whole part. A report that found no slug, or got no
 * further than opening the repository (`unobserved`), read nothing: its entry
 * carries this tick's refusal, and the part the line before held under the
 * slug its path last had stays, with that part's tick and time on the entry,
 * so a need does not leave the line because a read failed
 * (`line-unread.ts` names such repositories). Two times are kept apart: when
 * the part was read (`readAt`) and when the newest tick that tried started
 * (`triedAt`), which orders ticks that write out of turn. The rest belongs
 * to the whole machine (the accounts, the line's own tick and times, the
 * receipt beside it, except the recent tick durations and their maximum,
 * which every tick that reads adds its own to): a tick the timer asked for every repository writes it,
 * busy ones or not, and a wake-up for a few leaves it as it was, so a timer
 * that stopped still shows as one while woken ticks run.
 */
import type { LineRepo, LineSnapshot } from "./dashboard-contract.ts";
import { retainedSlug, unread } from "./line-unread.ts";

/** The line with each repository's entry marked as read by the tick `runId` that started at `at`; an entry that read nothing is marked as tried then, with no reading. */
export function readBy(
  line: LineSnapshot,
  runId: string,
  at: string,
): LineSnapshot {
  return {
    ...line,
    repos: line.repos.map((r) =>
      unread(r) ? { ...r, triedAt: at } : { ...r, runId, readAt: at },
    ),
  };
}

/**
 * `fresh`, built from the repositories one tick read, with every other
 * repository's part kept from `previous`, those it reported on but could not
 * identify included, in the machine file's order
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
  // A repository a newer tick tried since this one did keeps that tick's entry and part.
  const outdated = (r: LineRepo): boolean => {
    const before = keptPaths.get(r.path);
    return (
      before !== undefined &&
      (before.triedAt ?? before.readAt ?? previous.startedAt) >
        (r.triedAt ?? r.readAt ?? fresh.startedAt)
    );
  };
  const current = fresh.repos.filter((r) => !outdated(r));
  const read = new Set(
    current.flatMap((r) => (unread(r) || r.slug === null ? [] : [r.slug])),
  );
  const paths = new Set(listed.map((r) => r.path));
  const freshPaths = new Map(current.map((r) => [r.path, r]));
  // A path this tick did not identify keeps its part under the slug it last had.
  const unidentified = (path: string): boolean => {
    const now = freshPaths.get(path);
    return now === undefined || unread(now);
  };
  const kept = new Set(
    previous.repos.flatMap((r) => {
      const slug = retainedSlug(r);
      // An entry that no tick read holds no part to keep.
      return slug === undefined ||
        (unread(r) && r.readAt === undefined) ||
        !paths.has(r.path) ||
        !unidentified(r.path) ||
        read.has(slug)
        ? []
        : [slug];
    }),
  );
  const part = <T extends { repo: string }>(
    before: readonly T[],
    now: readonly T[],
  ): T[] => [
    // Host-wide records do not belong to a repository read set. Keep the
    // previous host part during a partial tick and replace it only when this
    // tick wrote the machine-wide part.
    ...before.filter((x) =>
      x.repo === "host" ? machine === "kept" : kept.has(x.repo),
    ),
    ...now.filter((x) =>
      x.repo === "host" ? machine === "fresh" : read.has(x.repo),
    ),
  ];
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
    answeredHolds: part(
      previous.answeredHolds ?? [],
      fresh.answeredHolds ?? [],
    ),
    carried: part(previous.carried ?? [], fresh.carried ?? []),
    queue: part(previous.queue, fresh.queue),
    ready: part(previous.ready ?? [], fresh.ready ?? []),
    repos: listed.flatMap(({ path }) => {
      const now = freshPaths.get(path);
      const before = keptPaths.get(path);
      // An entry no tick ever read has no reading to name.
      const from =
        before === undefined || (unread(before) && before.readAt === undefined)
          ? undefined
          : {
              runId: before.runId ?? previous.runId,
              readAt: before.readAt ?? previous.startedAt,
            };
      if (now === undefined)
        return before === undefined ? [] : [{ ...before, ...from }];
      // An entry that read nothing and whose part was kept names the tick that part is from.
      const slug = before === undefined ? undefined : retainedSlug(before);
      if (!(unread(now) && slug !== undefined && kept.has(slug))) return [now];
      // The retained part keeps its own identity and Ready omission count beside this attempt's entry.
      const { readyOmitted: _attempted, ...attempt } = now;
      return [
        {
          ...attempt,
          ...from,
          lastSlug: slug,
          ...(before?.readyOmitted === undefined
            ? {}
            : { readyOmitted: before.readyOmitted }),
          triedAt: now.triedAt ?? fresh.startedAt,
        },
      ];
    }),
  };
}

/**
 * The slugs of the line's repositories, with the identity the line before
 * held for a configured path whose report found none: a report that found no
 * slug replaces the entry, not the parks and receipts kept under it.
 */
export function identifiedSlugs(
  line: LineSnapshot,
  before: LineSnapshot | null,
  listed: ReadonlyArray<{ path: string }>,
): Set<string> {
  const slugs = new Set(
    line.repos.flatMap((r) => (r.slug === null ? [] : [r.slug])),
  );
  for (const old of before?.repos ?? []) {
    const now = line.repos.find((r) => r.path === old.path);
    const known = retainedSlug(old);
    if (
      known !== undefined &&
      now !== undefined &&
      (now.slug === null || unread(now)) &&
      listed.some((m) => m.path === old.path)
    )
      slugs.add(known);
  }
  return slugs;
}

/** The line with each unidentified repository carrying the slug its path last had, across repeated failures. */
export function withLastSlugs(
  line: LineSnapshot,
  before: LineSnapshot | null,
): LineSnapshot {
  return {
    ...line,
    repos: line.repos.map((r) => {
      if (r.slug !== null) return r;
      const old = before?.repos.find((b) => b.path === r.path);
      const known = old === undefined ? undefined : retainedSlug(old);
      return known === undefined ? r : { ...r, lastSlug: known };
    }),
  };
}

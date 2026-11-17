/**
 * What the line says it could not read. A repository whose newest read was
 * refused keeps the part of the line the tick that last read it found
 * (`line-merge.ts`), so the line is incomplete there: `jig ask --waiting` and
 * the dashboard's answer name each such repository, and the tick strip marks
 * a tick that could read none of the repositories it reported on. Pure, with
 * no imports but types, so the dashboard's page uses it as the plugin does.
 */
import type { LineRepo, LineSnapshot, LineTick } from "./dashboard-contract.ts";

/** Whether the tick that wrote the entry read nothing of its repository: it found no slug, or got no further than opening it. */
export function unread(r: Pick<LineRepo, "slug" | "unobserved">): boolean {
  return r.slug === null || r.unobserved === true;
}

/** The slug the repository's retained part is under: an entry that read nothing names it in `lastSlug`, whatever slug the newest attempt found; else the entry's slug, else its last one. */
export function retainedSlug(
  r: Pick<LineRepo, "slug" | "unobserved" | "lastSlug">,
): string | undefined {
  return unread(r) && r.lastSlug !== undefined
    ? r.lastSlug
    : (r.slug ?? r.lastSlug);
}

/** A repository whose newest read was refused, and the reading its part of the line is from. */
export interface RefusedRepo {
  /** Its slug, else the slug its path last had, else its path when no tick has identified it. */
  repo: string;
  /** Why the newest tick that tried could not read it, verbatim. */
  refused: string;
  /** When the tick its part of the line is from started; `null` when no tick has read it, so the line holds nothing of it. */
  readAt: string | null;
}

/** The line's repositories whose newest read was refused, in the machine file's order. */
export function refusedRepos(line: LineSnapshot): RefusedRepo[] {
  return line.repos.flatMap((r) => {
    if (r.refused === null) return [];
    const known = retainedSlug(r);
    // An entry that read nothing holds the part its path last had, if any, with that reading's time.
    const readAt = !unread(r)
      ? (r.readAt ?? line.startedAt)
      : known === undefined
        ? null
        : (r.readAt ?? null);
    return [{ repo: known ?? r.path, refused: r.refused, readAt }];
  });
}

/** Whether the tick reported on repositories and could read none of them. */
export function readNothing(
  tick: Pick<LineTick, "repos" | "refused">,
): boolean {
  const refused = tick.refused ?? [];
  return refused.length > 0 && refused.length >= tick.repos.length;
}

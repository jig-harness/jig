/**
 * What the line says it could not read. A repository whose newest read was
 * refused keeps the part of the line the tick that last read it found
 * (`line-merge.ts`), so the line is incomplete there: `jig ask --waiting` and
 * the dashboard's answer name each such repository, and the tick strip marks
 * a tick that could read none of the repositories it reported on. Pure, with
 * no imports but types, so the dashboard's page uses it as the plugin does.
 */
import type { LineSnapshot, LineTick } from "./dashboard-contract.ts";

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
    const known = r.slug ?? r.lastSlug;
    // A report with a slug brought this tick's part; one without kept the part its path last had, if any.
    const readAt =
      r.slug !== null
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

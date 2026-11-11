/**
 * How often each kind of parked decision follows the recommendation, read
 * from the outcome log's park rows alone (`park-events.ts`): per
 * repository and decision class, how many parks the log counted, how many
 * were answered, how many of those chose the recommended option with no
 * note, and the median wait for an answer. A park still waiting has no row,
 * so it is in none of the counts. It is evidence for a person
 * deciding whether a class should stay a park
 * ([ADR-0010](../../../docs/adr/ADR-0010-parking-is-reserved-for-registry-classes.md));
 * nothing plans from it.
 */
import type { LogRow } from "./log.ts";

/** One decision class on one repository. */
export interface AcceptanceRow {
  repo: string;
  /** The decision class; `null` for parks from before classes. */
  class: string | null;
  /** Every park occurrence the log counted: answered, handed on and removed. */
  parks: number;
  answered: number;
  /** Answered by choosing the recommended option (`approve`, or `choose` of that option) with no note. */
  asRecommended: number;
  /** The median wait for an answer, in milliseconds; `null` when no answered park has one. */
  medianWaitMs: number | null;
}

/** The middle wait, or the mean of the two middle ones. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Per repository and class, from the park rows among `rows`; other rows are ignored. */
export function acceptanceOf(rows: readonly LogRow[]): AcceptanceRow[] {
  const groups = new Map<string, AcceptanceRow & { waits: number[] }>();
  for (const row of rows) {
    if (row.kind !== "event" || row.park === undefined) continue;
    const id = JSON.stringify([row.repo, row.park.class]);
    let group = groups.get(id);
    if (group === undefined) {
      group = {
        repo: row.repo,
        class: row.park.class,
        parks: 0,
        answered: 0,
        asRecommended: 0,
        medianWaitMs: null,
        waits: [],
      };
      groups.set(id, group);
    }
    group.parks++;
    if (row.park.outcome !== "answered") continue;
    group.answered++;
    if (row.park.recommended === true && !row.park.note) group.asRecommended++;
    if (row.durationMs !== undefined) group.waits.push(row.durationMs);
  }
  return [...groups.values()]
    .map(({ waits, ...group }) => ({ ...group, medianWaitMs: median(waits) }))
    .sort(
      (a, b) =>
        a.repo.localeCompare(b.repo) ||
        (a.class ?? "").localeCompare(b.class ?? ""),
    );
}

/** A wait as its two largest units: `3d 4h`, `2h 5m`, `45s`. */
export function waitText(ms: number | null): string {
  if (ms === null) return "-";
  const seconds = Math.round(ms / 1000);
  const units: Array<[string, number]> = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
    ["s", 1],
  ];
  const parts: string[] = [];
  let left = seconds;
  for (const [name, size] of units) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0 || (parts.length > 0 && parts.length < 2))
      parts.push(`${n}${name}`);
    if (parts.length === 2) break;
  }
  return parts.length === 0 ? "0s" : parts.join(" ");
}

/** One row as a line for a person: repository, class, parks, answered, as recommended, median wait. */
export function acceptanceLine(row: AcceptanceRow): string {
  return [
    row.repo,
    row.class ?? "(no class)",
    `${row.parks} parks`,
    `${row.answered} answered`,
    `${row.asRecommended} as recommended`,
    `median wait ${waitText(row.medianWaitMs)}`,
  ].join("\t");
}

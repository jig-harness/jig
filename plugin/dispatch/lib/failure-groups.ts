/**
 * The cause of each failing row of this host's own (a repository's turn, a
 * tick scope), and the rows gathered by it, so one fault that fails every
 * scope it touches is told once (`failures.group: cause`, the default).
 *
 * A row keeps only its last reason, one sentence, so the cause is read from
 * it against a closed list: the session runtime, the state database, the
 * configuration, the tracker, the forge, and other for a reason none of them
 * names. A record that did not read names its own system first (`the
 * tracker record (…) did not read: …`), and that name decides; otherwise the
 * first system the reason names, in the order below, does: a forge call
 * that failed while the configuration was read is the forge's fault, and
 * the configuration's only when no system failed.
 *
 * A tick scope's reason names the repository whose turn failed before
 * that turn's own reason; the repository's name is left out, so a word in
 * it never reads as a system.
 *
 * A group's identity is its cause alone, so a scope that joins it, leaves
 * it or moves to another cause and back keeps the one notice while any row
 * of that cause stands; it retires with the last of them. A fault that
 * comes back after that is told under the same key, so where the
 * destination still shows the earlier notice the tick counts it told, and
 * tells it again on `dispatch.renotify_after`.
 */
import type { FailureRow } from "./failures.ts";

/** What a host row's failure is the fault of. */
export type RowCause =
  | "runtime"
  | "state"
  | "configuration"
  | "tracker"
  | "forge"
  | "other";

/** The cause each pattern names, first match deciding. */
const PATTERNS: ReadonlyArray<readonly [RowCause, RegExp]> = [
  ["runtime", /\bthe runtime record\b/i],
  ["tracker", /\bthe tracker record\b/i],
  ["forge", /\bthe forge record\b/i],
  [
    "state",
    /\bstate database\b|\bsqlite\b|\bdatabase is (locked|busy)\b|\blaunch record\b|\boutcome log\b/i,
  ],
  ["runtime", /\bruntime\b|\borca\b|\bherdr\b/i],
  ["tracker", /\btracker\b|\blinear\b|\bjira\b/i],
  ["forge", /\bforge\b|\bgithub\b|\bgh\b|\bgraphql\b|\bHTTP \d{3}\b/i],
  [
    "configuration",
    /\bconfiguration\b|\bconfig\b|jig\.yaml|\bdispatch section\b|\bmachine file\b|\bcatalog\b|\btaxonomy\b/i,
  ],
];

/** The opening of a tick's reason that names the repository whose turn failed. */
const FAILED_TURN =
  /^(?:a repository's turn failed|\d+ repositories' turns failed), [^\s:]+: /;

/** The cause a row's reason names. */
export function rowCause(reason: string): RowCause {
  const own = reason.replace(FAILED_TURN, "");
  return PATTERNS.find(([, pattern]) => pattern.test(own))?.[0] ?? "other";
}

/** A cause as a notice names it. */
export const CAUSE_WORDS: Readonly<Record<RowCause, string>> = {
  runtime: "the session runtime",
  state: "the state database",
  configuration: "the configuration",
  tracker: "the tracker",
  forge: "the forge",
  other: "a cause the ledger does not name",
};

/** Whether a row is one of this host's own: a repository's turn or a tick scope. */
function isHostRow(row: FailureRow): boolean {
  return row.kind === "tick" || row.kind === "repository";
}

/** The rows gathered by cause, each group in the order the rows came. */
export function byCause(
  rows: readonly FailureRow[],
): Map<RowCause, FailureRow[]> {
  const groups = new Map<RowCause, FailureRow[]>();
  for (const row of rows) {
    const cause = rowCause(row.reason);
    groups.set(cause, [...(groups.get(cause) ?? []), row]);
  }
  return groups;
}

/** The earliest first failure of `rows`; `""` for none. */
export function earliest(rows: readonly FailureRow[]): string {
  return rows.map((r) => r.firstAt).sort()[0] ?? "";
}

/** The standing host rows: those a quiet has not settled. */
export function standingHostRows(rows: readonly FailureRow[]): FailureRow[] {
  return rows.filter((r) => isHostRow(r) && r.quietAt === null);
}

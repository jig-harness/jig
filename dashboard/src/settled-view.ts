/**
 * What the "Settled recently" section says of each entry the line carries
 * (`LineSettled`): who settled it and how in one line, and the link to the
 * History rows of its target. The wording is the page's; the facts come from
 * the tick's records.
 */
import type { LineSettled } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { parseMs } from "../../plugin/shared/time.ts";
import { withParam } from "./search.ts";
import type { Clock } from "./view.ts";

/** The window the tick keeps the list to, in words. */
const SETTLED_WINDOW_WORDS = "24 hours";

/** The entries the page lists: those inside the window as of the page's clock, newest first. */
export function settledIn(
  settled: readonly LineSettled[] | undefined,
  clock: Pick<Clock, "nowMs">,
): LineSettled[] {
  const since = clock.nowMs - 24 * 3_600_000;
  return (settled ?? [])
    .filter((e) => parseMs(e.at) >= since)
    .sort((a, b) => parseMs(b.at) - parseMs(a.at));
}

/** The folded line's words: how many settled, and what its toggle does. */
export function settledToggle(count: number, open: boolean): string {
  return `${count} settled in the last ${SETTLED_WINDOW_WORDS} · ${open ? "hide" : "show"}`;
}

/** Who settled an entry, in words. */
export function byWords(e: LineSettled): string {
  switch (e.by) {
    case "person":
      return `${e.who ?? "a person"}${e.via === null ? "" : ` (${e.via})`}`;
    case "tick":
      return `the tick (${e.who ?? "a rule"})`;
    case "steward":
      return `the steward (${e.who ?? "a record"})`;
    case "facts":
      return "no one: its facts changed";
  }
}

/** What an entry says happened to its need: it left, or its answer did not settle it. */
export function outcomeWords(e: LineSettled): string {
  if (e.outcome === "left") return "Left";
  return e.outcome === "refused"
    ? "Refused, card still open"
    : "Held, card still open";
}

/** The address that opens History on an entry's target, keeping the page's other parameters (its token among them). */
export function historyQuery(search: string, e: LineSettled): string {
  let query = withParam(search, "view", "history");
  query = withParam(query, "window", "7d");
  query = withParam(query, "repo", e.repo);
  return withParam(query, "target", e.targets[0] ?? "");
}

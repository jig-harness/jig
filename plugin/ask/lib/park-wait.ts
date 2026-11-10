/**
 * Whether a park is answered, and what a parked drive waits on: an answer
 * from the people its open parks name, under the act the dashboard's card
 * names for it (`shared/acts.ts`).
 */
import { actOfClass, actOfLineNeed, type NeedAct } from "../../shared/acts.ts";
import { uniqueLogins } from "../../shared/forge-logins.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { personWait, type WaitsOn } from "./answer.ts";
import type { ParkAnswers } from "./park-reading.ts";
import type { AskContext } from "./station.ts";
import { lineNeeds } from "./line-needs.ts";

/** The newest tick's park on a pull request: the act its card shows and the decision that act derives from. */
export interface LinePark {
  act: NeedAct;
  /** The key of the oldest decision the park waits on; `null` when it lists none. */
  key: string | null;
  /** The class that decision was parked under; `null` when it names none. */
  decisionClass: string | null;
}

/**
 * The newest tick's line's park on pull request `pr`, so the answer and the
 * dashboard's card read one record; `null` on a machine that keeps no line,
 * whose line holds no park there, or whose line cannot be read. Reading it
 * costs no forge call, and the read is noted as the tick line's source.
 */
export function lineParkOf(ctx: AskContext, pr: number): LinePark | null {
  const need = lineNeeds(ctx).find((n) => n.pr === pr && n.cause === "parked");
  return need === undefined
    ? null
    : {
        act: actOfLineNeed(need),
        key: need.decisions[0]?.key ?? null,
        decisionClass: need.decisions[0]?.decisionClass ?? null,
      };
}

/**
 * A parked drive's wait: its open parks' people (the author for a park that
 * names none), and the act the line names (`linePark`) or, with no line, the
 * oldest open park's class's. Its act is the one the card
 * shows, provided the decision it derives from is still open here under the class
 * the line read: a line older than an answer, a newer park or a re-park of the
 * same key under another class names a decision that is not, and
 * the act then comes from the open parks' class.
 */
export function parkedWait(
  parked: Ledger["parked"],
  found: ParkAnswers | null,
  author: string,
  why: string,
  linePark: LinePark | null,
): WaitsOn {
  const open = parked.filter(
    (p) =>
      found === null ||
      "unreadable" in found ||
      !found.answered.some((v) => v.key === p.key),
  );
  const current =
    linePark !== null &&
    open.some(
      (p) =>
        p.key === linePark.key && (p.class ?? null) === linePark.decisionClass,
    )
      ? linePark.act
      : null;
  return personWait("answer", why, {
    act: current ?? actOfClass(open[0]?.class),
    people: uniqueLogins(
      open.flatMap((p) =>
        p.person === undefined ? [author].filter(Boolean) : [p.person],
      ),
    ),
  });
}

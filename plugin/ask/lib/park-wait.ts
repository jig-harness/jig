/**
 * Whether a park is answered, and what a parked drive waits on: an answer
 * from the people its open parks name, under the act the dashboard's card
 * names for it (`shared/acts.ts`).
 */
import { readLine } from "../../dispatch/lib/line-store.ts";
import { actOfClass, actOfLineNeed, type NeedAct } from "../../shared/acts.ts";
import { uniqueLogins } from "../../shared/forge-logins.ts";
import { answersKey } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { personWait, type WaitsOn } from "./answer.ts";
import type { CommentFields } from "./forge.ts";
import type { AskContext } from "./station.ts";
import { countsAsAnswer } from "./thread.ts";

/** Whether a trusted comment made after the park answers its key, as the re-arm reads an answer. */
export function answered(
  key: string,
  at: string | undefined,
  comments: readonly CommentFields[],
): boolean {
  if (at === undefined) return false;
  const after = Date.parse(at);
  return comments.some(
    (c) => countsAsAnswer(c, after) && answersKey(c.body, key),
  );
}

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
  if (ctx.dispatcher === null) return null;
  const line = readLine(ctx.dispatcher);
  ctx.reading.note(
    line.ok
      ? { record: "dispatch-tick-line", read: true, local: true }
      : {
          record: "dispatch-tick-line",
          read: false,
          local: true,
          detail: line.failure.reason,
        },
  );
  if (!line.ok || line.value === null) return null;
  const need = line.value.needs.find(
    (n) => n.repo === ctx.address.repo && n.pr === pr && n.cause === "parked",
  );
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
 * oldest open park's class's. The line also counts a reply on a parked
 * thread as its answer, which this read of the conversation does not, so
 * its open parks are a subset of ours and its act is the one the card
 * shows, provided the decision it derives from is still open here under the class
 * the line read: a line older than an answer, a newer park or a re-park of the
 * same key under another class names a decision that is not, and
 * the act then comes from the open parks' class.
 */
export function parkedWait(
  parked: Ledger["parked"],
  comments: readonly CommentFields[] | null,
  author: string,
  why: string,
  linePark: LinePark | null,
): WaitsOn {
  const open = parked.filter(
    (p) => comments === null || !answered(p.key, p.at, comments),
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

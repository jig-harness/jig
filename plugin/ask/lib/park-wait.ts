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

/**
 * The act the newest tick's line names for the park on pull request `pr`, so
 * the answer and the dashboard's card read one record; `null` on a machine
 * that keeps no line or whose line holds no park there. Reading it costs no
 * forge call; that it was read is the tick line's source, which the
 * pick-up station notes too.
 */
export function lineParkAct(ctx: AskContext, pr: number): NeedAct | null {
  if (ctx.dispatcher === null) return null;
  const line = readLine(ctx.dispatcher);
  if (!line.ok || line.value === null) return null;
  const need = line.value.needs.find(
    (n) => n.repo === ctx.address.repo && n.pr === pr && n.cause === "parked",
  );
  return need === undefined ? null : actOfLineNeed(need);
}

/**
 * A parked drive's wait: its open parks' people (the author for a park that
 * names none), and the act the line names (`lineAct`) or, with no line, the
 * oldest open park's class's. The line also counts a reply on a parked
 * thread as its answer, which this read of the conversation does not, so
 * the line's act is the one the card shows.
 */
export function parkedWait(
  parked: Ledger["parked"],
  comments: readonly CommentFields[] | null,
  author: string,
  why: string,
  lineAct: NeedAct | null,
): WaitsOn {
  const open = parked.filter(
    (p) => comments === null || !answered(p.key, p.at, comments),
  );
  return personWait("answer", why, {
    act: lineAct ?? actOfClass(open[0]?.class),
    people: uniqueLogins(
      open.flatMap((p) =>
        p.person === undefined ? [author].filter(Boolean) : [p.person],
      ),
    ),
  });
}

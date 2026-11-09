/**
 * Whether a park is answered, and what a parked drive waits on: an answer
 * from the people its open parks name, under the act the oldest open park's
 * class names (`shared/acts.ts`), as the dashboard's card names it.
 */
import { actOfClass } from "../../shared/acts.ts";
import { uniqueLogins } from "../../shared/forge-logins.ts";
import { answersKey } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { personWait, type WaitsOn } from "./answer.ts";
import type { CommentFields } from "./forge.ts";
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

/** A parked drive's wait: its open parks' people (the author for a park that names none), and the oldest open park's act. */
export function parkedWait(
  parked: Ledger["parked"],
  comments: readonly CommentFields[] | null,
  author: string,
  why: string,
): WaitsOn {
  const open = parked.filter(
    (p) => comments === null || !answered(p.key, p.at, comments),
  );
  return personWait("answer", why, {
    act: actOfClass(open[0]?.class),
    people: uniqueLogins(
      open.flatMap((p) =>
        p.person === undefined ? [author].filter(Boolean) : [p.person],
      ),
    ),
  });
}

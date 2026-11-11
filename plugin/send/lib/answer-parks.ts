/**
 * What an answer is checked against: the open pull request, its drive
 * ledger's parked items and every place an answer to them could be, read
 * through `jig ask`'s readers (`ask/lib/drive.ts`, `ask/lib/park-reading.ts`)
 * so a send sees the items, their digests and their answers as the re-arm
 * and the tick do. A read that is not complete refuses: an answer is never
 * planned on a partial history.
 */
import { ok, type Outcome } from "../../shared/outcome.ts";
import { readDrive } from "../../ask/lib/drive.ts";
import { answerText } from "../../ask/lib/park-reading.ts";
import type { PullDoc } from "../../ask/lib/forge.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import type { ParkAnswersResult } from "../../skills/drive-pr/scripts/lib/driver/park-answers.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import type { PendingAnswer } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import { NEXT_TICK, refused, type TickReader } from "./plan.ts";
import { openDrive } from "./open-drive.ts";

/** Who sends an answer, and how: the login it writes as, whether this is a dry run, and the `--as` it was given. */
export interface Sender {
  login: string;
  writesAs: string;
  dryRun: boolean;
  as?: string | undefined;
}

/** The `--as` a printed command repeats, so it is the command the person ran. */
export const asFlag = (sender: Sender) =>
  sender.as === undefined ? "" : ` --as ${sender.as}`;

/** Every place an answer could be, read whole. */
export type ReadParks = Exclude<ParkAnswersResult, { unreadable: string }>;

export interface Parks {
  pr: number;
  doc: PullDoc;
  ledger: Ledger;
  found: ReadParks;
}

/** The re-arm, which the tick starts under the rearm stage, as an answer's reader. */
export const TICK: TickReader = {
  stage: "rearm",
  reader: (tick) =>
    `the re-arm, which hands your answer to the drive's passes as your verdict once every parked question is answered: ${tick} where a dispatcher reads the pull request, else the re-arm command the stop printed`,
};
export const ANSWER_READER = TICK.reader(NEXT_TICK);

export const READABLE_NOTICE =
  "the answer is a comment on the pull request, readable by whoever can read the pull request";

/** The pull request's parked items and their answers, or why an answer cannot be checked against them. */
export async function readParks(
  ctx: AskContext,
): Promise<Outcome<Parks, "refused">> {
  const d = await readDrive(ctx);
  const pr = Number(ctx.address.key);
  const opened = openDrive(d, pr, "no drive waits on an answer");
  if (!opened.ok) return opened;
  if (d.comments === null)
    return refused(
      `the comments of pull request ${pr} did not read, so its parked questions and their answers are not known`,
    );
  if (d.ledger === null)
    return refused(
      `pull request ${pr} has no drive ledger, so it has no parked question`,
    );
  if (typeof d.ledger === "string")
    return refused(
      `the parked questions of pull request ${pr} cannot be read: ${d.ledger}`,
    );
  if (d.parks === null || "unreadable" in d.parks || d.parks.unread.length > 0)
    return refused(
      `not every place an answer to pull request ${pr}'s parked questions could be was read; no answer is sent`,
    );
  return ok({ pr, doc: opened.value, ledger: d.ledger, found: d.parks });
}

/** Each person's latest answer to `key` that the readers found, stale ones included. */
export function answersTo(found: ReadParks, key: string): PendingAnswer[] {
  return found.responses.find((r) => r.item.key === key)?.answers ?? [];
}

const ANSWER_SHOWN_MAX = 200;

/** One earlier answer as the plan shows it, `whose` naming its author. */
export function earlierAnswer(a: PendingAnswer, whose: string): string {
  const text = answerText(a).replace(/\s+/g, " ").trim();
  const shown =
    [...text].length > ANSWER_SHOWN_MAX
      ? `${[...text].slice(0, ANSWER_SHOWN_MAX).join("")}…`
      : text;
  return `${whose} at ${a.at}${a.stale === true ? " (stale: it names another framing)" : ""}: ${shown} (${a.url})`;
}

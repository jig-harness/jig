/** Read a parked drive's answers into the dispatcher's report shape. */
import { parkAnswers } from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { framedDecisionLines } from "../../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import type { WaitingPark } from "../types.ts";

/** What answers a park's items, when the ledger stopped `HITL_PARKED`. */
export type ParkReading =
  | {
      answered: number;
      waiting: string[];
      parks?: WaitingPark[];
      disputed?: string[];
    }
  | { unreadable: string };

export async function readPark(
  pr: number,
  ledger: Ledger,
  slug: string,
  listing: readonly unknown[] | undefined,
): Promise<ParkReading | undefined> {
  if (
    ledger.driver.state !== "stopped" ||
    ledger.driver.exit !== DRIVE_EXIT.HITL_PARKED
  )
    return undefined;
  const found = await parkAnswers(pr, ledger.parked, slug, listing);
  if (!("unreadable" in found) && found.unread.length > 0)
    return {
      unreadable: found.unread.map((p) => `${p.kind} ${p.key}`).join(", "),
    };
  return "unreadable" in found
    ? found
    : {
        answered: found.answered.length,
        disputed: found.disputed.map((d) => `${d.item.kind} ${d.item.key}`),
        waiting: found.waiting.map((p) => `${p.kind} ${p.key}`),
        parks: found.waiting.map((p) => {
          const disputed = found.disputed.find((d) => d.item.key === p.key);
          const stale = found.stale.find((d) => d.item.key === p.key);
          return {
            ...(p.person === undefined ? {} : { person: p.person }),
            key: p.key,
            kind: p.kind,
            ...(p.digest === undefined ? {} : { digest: p.digest }),
            ...(p.at === undefined ? {} : { parkedAt: p.at }),
            ...(stale === undefined ? {} : { stale: stale.answers }),
            lines: framedDecisionLines(p),
            ...(p.decision === undefined ? {} : { decision: p.decision }),
            ...(disputed === undefined ? {} : { disputed: disputed.answers }),
          };
        }),
      };
}

/** Read a parked drive's answers into the dispatcher's report shape. */
import {
  parkAnswers,
  threadComments,
} from "../../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { framedDecisionLines } from "../../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { CUT_AT_BOUND, ended, secondsLeft, type TickBound } from "./bounded.ts";
import { combinedFailure, readFailureOf } from "../read-failures.ts";
import type { ReadFailure, WaitingPark } from "../types.ts";

/** What answers a park's items, when the ledger stopped `HITL_PARKED`; where they did not read, the failed calls' class. */
export type ParkReading =
  | {
      answered: number;
      waiting: string[];
      parks?: WaitingPark[];
      disputed?: string[];
    }
  | { unreadable: string; failure?: ReadFailure };

export async function readPark(
  pr: number,
  ledger: Ledger,
  slug: string,
  listing: readonly unknown[] | undefined,
  loaders: Parameters<typeof parkAnswers>[4] = {},
  bound?: TickBound,
): Promise<ParkReading | undefined> {
  if (
    ledger.driver.state !== "stopped" ||
    ledger.driver.exit !== DRIVE_EXIT.HITL_PARKED
  )
    return undefined;
  // A thread whose read failed is kept with the failed call's class, which decides whether the tick waits it out.
  const failures = new Map<string, ReadFailure | undefined>();
  const found = await parkAnswers(pr, ledger.parked, slug, listing, {
    // No thread is read once the tick's bound has ended; one in flight gets only the time the bound has left.
    threadComments: (key) => {
      if (ended(bound)) {
        failures.set(key, CUT_AT_BOUND);
        return Promise.resolve(null);
      }
      return threadComments(key, secondsLeft(bound), (f) =>
        failures.set(key, readFailureOf(f)),
      );
    },
    ...loaders,
  });
  if (!("unreadable" in found) && found.unread.length > 0) {
    // A park with no time is also an unclassified defect beside its thread's failed call, so a class that waiting does not clear still wins over it.
    const failure = combinedFailure(
      found.unread.flatMap((p) =>
        p.at === undefined
          ? [failures.get(p.key), undefined]
          : [failures.get(p.key)],
      ),
    );
    return {
      unreadable: found.unread.map((p) => `${p.kind} ${p.key}`).join(", "),
      ...(failure === undefined ? {} : { failure }),
    };
  }
  return "unreadable" in found
    ? found
    : {
        answered: found.answered.length,
        disputed: found.disputed.map((d) => `${d.item.kind} ${d.item.key}`),
        waiting: found.waiting.map((p) => `${p.kind} ${p.key}`),
        parks: found.waiting.map((p) => {
          const disputed = found.disputed.find((d) => d.item.key === p.key);
          const stale = found.stale.find((d) => d.item.key === p.key);
          const answers = found.responses.find((d) => d.item.key === p.key);
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
            ...(answers === undefined ? {} : { answers: answers.answers }),
          };
        }),
      };
}

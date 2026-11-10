/**
 * The drive's own state label agrees with the dispatcher's classification
 * of the same stop, for every exit `drive.ts` ends with: both read one exit
 * table (`skills/drive-pr/scripts/lib/status/exit-classes.ts`). The one
 * deliberate difference: where the dispatcher re-drives a stop (`stale`),
 * the drive labels it `parked`, which a tick replaces with `stale` where a
 * dispatcher runs.
 */
import { describe, expect, it } from "bun:test";
import { ledgerAt } from "../../skills/drive-pr/scripts/lib/driver/state-labels.ts";
import {
  type Ledger,
  ledgerFromState,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { freshState } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  ledgerState,
  type Projected,
} from "../../shared/pr-labels/projection.ts";
import { classifyLedger } from "../lib/sources/ledgers.ts";

const SHA = "a91d4f7c05444444444444444444444444444444";
const BASE = "de7e10ba5e222222222222222222222222222222";
const EXITS = {
  converged: DRIVE_EXIT.CONVERGED,
  takenOver: DRIVE_EXIT.TAKEN_OVER,
};
const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function stopped(exit: number, personStop = false): Ledger {
  return ledgerFromState(
    { ...freshState(7), verifiedSha: SHA },
    {
      generation: 2,
      driver: {
        actor: "wt-0123456789abcdef",
        clone: "clone-a",
        heartbeat: "2026-11-10T11:00:00.000Z",
        state: "stopped",
        exit,
        ...(personStop
          ? { personStop: { at: "2026-11-10T11:00:00.000Z", reason: "" } }
          : {}),
      } as Ledger["driver"],
      narrative: [],
      claims: [],
    },
  );
}

/** The dispatcher's state for a stop on a pull request still at the verified head, mergeable, its park unanswered. */
function dispatcherState(ledger: Ledger, exit: number): Projected {
  const read = classifyLedger(
    ledger,
    NOW,
    60 * 60_000,
    { answered: 0, waiting: ["PRRT_parked"] },
    { head: SHA, mergeable: "MERGEABLE", base: { oid: BASE } },
  );
  return ledgerState({ class: read.class, exit }, EXITS);
}

function driveState(exit: number, byPerson = false): Projected {
  const reading = ledgerAt({ stopped: exit, byPerson, verifiedSha: SHA });
  return reading === null ? "unknown" : ledgerState(reading, EXITS);
}

/** What the drive writes where the dispatcher projects `state`: the same, but `parked` for a re-drive. */
function expected(state: Projected): Projected {
  return state !== "unknown" && state.state === "stale"
    ? { state: "parked" }
    : state;
}

describe("the drive's stop label and the dispatcher's classification", () => {
  for (const [name, exit] of Object.entries(DRIVE_EXIT))
    it(`agree on ${name} (${exit})`, () => {
      expect(driveState(exit)).toEqual(
        expected(dispatcherState(stopped(exit), exit)),
      );
    });

  it("agree on an exit the registry does not name: a person settles it", () => {
    expect(dispatcherState(stopped(2), 2)).toEqual({ state: "parked" });
    expect(driveState(2)).toEqual({ state: "parked" });
  });

  it("agree on a person's recorded stop, whatever its exit", () => {
    for (const exit of [DRIVE_EXIT.CONVERGED, DRIVE_EXIT.NOT_SETTLED]) {
      expect(dispatcherState(stopped(exit, true), exit)).toEqual({
        state: "parked",
      });
      expect(driveState(exit, true)).toEqual({ state: "parked" });
    }
  });

  it("label a stop only a person settles parked, MAX_ROUNDS and REVIEWER_FAILED among them", () => {
    for (const exit of [
      DRIVE_EXIT.MAX_ROUNDS,
      DRIVE_EXIT.REVIEWER_FAILED,
      DRIVE_EXIT.MAILBOX_STOPPED,
      DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT,
      DRIVE_EXIT.STALLED,
    ])
      expect(driveState(exit)).toEqual({ state: "parked" });
    // A stop on a pull request no longer open leaves its labels.
    expect(driveState(DRIVE_EXIT.PR_NOT_OPEN)).toBe("unknown");
  });
});

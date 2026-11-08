/**
 * dispatch: every place the dispatcher classifies a drive's exit reads the
 * exit by its name in drive-pr's terminal-state registry. Each case below
 * names the state, never its number, so a code the registry moves moves
 * here too, and a classifier that kept the old number fails.
 */
import { describe, expect, it } from "bun:test";
import {
  DRIVE_EXIT,
  type DriveExitName,
  DRIVER_REFUSAL_EXITS,
  driveExitClosesTab,
  PERSON_STOP_EXITS,
  TERMINAL_STATES,
} from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { driveClass } from "../lib/log.ts";
import { classifyLedger } from "../lib/sources/ledgers.ts";
import { stoppedLedger } from "./fixtures.ts";

const NOW = Date.parse("2026-10-31T00:00:00.000Z");
const WINDOW = 240 * 60_000;

const ledgerClass = (name: DriveExitName) =>
  classifyLedger(stoppedLedger(7, DRIVE_EXIT[name]), NOW, WINDOW).class;

const logClass = (name: DriveExitName, merged: boolean | null = null) =>
  driveClass(DRIVE_EXIT[name], merged).class;

describe("the registry's exits for the dispatcher", () => {
  it("are drive.ts's own: CONVERGED as drive.ts remaps it, every other state its own code", () => {
    expect(DRIVE_EXIT.CONVERGED).toBe(
      TERMINAL_STATES.CONVERGED.additionalExitCodes?.[0] as number,
    );
    for (const [name, code] of Object.entries(DRIVE_EXIT))
      if (name !== "CONVERGED")
        expect(code).toBe(TERMINAL_STATES[name]?.exitCode as number);
  });

  it("group the refusals of a second driver and a person's stops", () => {
    expect([...DRIVER_REFUSAL_EXITS].sort()).toEqual(
      [
        DRIVE_EXIT.SINGLE_INSTANCE_LOCK,
        DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE,
        DRIVE_EXIT.TAKEN_OVER,
      ].sort(),
    );
    expect([...PERSON_STOP_EXITS].sort()).toEqual(
      [DRIVE_EXIT.MAILBOX_STOPPED, DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT].sort(),
    );
  });
});

describe("a stopped ledger's class", () => {
  it("reads each exit by its state", () => {
    const cases: Array<[DriveExitName, string]> = [
      ["PR_NOT_OPEN", "done"],
      ["TAKEN_OVER", "done"],
      ["MAILBOX_STOPPED", "stopped-by-person"],
      ["MAILBOX_PAUSE_TIMEOUT", "stopped-by-person"],
      ["QUOTA_PARKED", "re-armable"],
      ["NOT_SETTLED", "re-armable"],
      ["SINGLE_INSTANCE_LOCK", "refused"],
      ["DRIVE_HELD_BY_OTHER_WORKTREE", "refused"],
      ["INDETERMINATE", "needs-person"],
      ["UNSUPPORTED_CLI", "needs-person"],
      ["MAX_ROUNDS", "needs-person"],
      ["REVIEWER_FAILED", "needs-person"],
      ["REVIEW_SKIPPED", "needs-person"],
      ["WORKTREE_UNCLEAN", "needs-person"],
    ];
    for (const [name, cls] of cases)
      expect<[string, string]>([name, ledgerClass(name)]).toEqual([name, cls]);
  });

  it("reads the pull request beside CONVERGED, PR_CONFLICTING, STALLED, CI_REPAIR_SPENT and PASS_DEADLINE, and the parks beside HITL_PARKED", () => {
    // With nothing read from the forge or the parks, none of them can be placed yet.
    expect(ledgerClass("CONVERGED")).toBe("unplaced");
    expect(ledgerClass("PR_CONFLICTING")).toBe("unplaced");
    expect(ledgerClass("STALLED")).toBe("unplaced");
    expect(ledgerClass("CI_REPAIR_SPENT")).toBe("unplaced");
    expect(ledgerClass("PASS_DEADLINE")).toBe("unplaced");
    expect(ledgerClass("HITL_PARKED")).toBe("unplaced");
    expect(
      classifyLedger(stoppedLedger(7, DRIVE_EXIT.HITL_PARKED), NOW, WINDOW, {
        answered: 1,
        waiting: [],
      }).class,
    ).toBe("re-armable");
  });
});

describe("an ended drive's outcome class", () => {
  it("reads each exit by its state", () => {
    const cases: Array<[DriveExitName, string]> = [
      ["CONVERGED", "converged"],
      ["QUOTA_PARKED", "quota wall"],
      ["HITL_PARKED", "parked for a person"],
      ["STALLED", "stalled"],
      ["MAX_ROUNDS", "stalled"],
      ["UNSUPPORTED_CLI", "refused"],
      ["NOT_SETTLED", "refused"],
      ["SINGLE_INSTANCE_LOCK", "refused"],
      ["DRIVE_HELD_BY_OTHER_WORKTREE", "refused"],
      ["MAILBOX_STOPPED", "refused"],
      ["MAILBOX_PAUSE_TIMEOUT", "refused"],
      ["TAKEN_OVER", "refused"],
      ["INDETERMINATE", "gates failed"],
      ["REVIEWER_FAILED", "gates failed"],
      ["REVIEW_SKIPPED", "gates failed"],
      ["PR_CONFLICTING", "gates failed"],
      ["WORKTREE_UNCLEAN", "gates failed"],
      ["PASS_DEADLINE", "gates failed"],
      ["CI_REPAIR_SPENT", "gates failed"],
    ];
    for (const [name, cls] of cases)
      expect<[string, string]>([name, logClass(name)]).toEqual([name, cls]);
  });

  it("reads PR_NOT_OPEN beside whether the pull request merged", () => {
    expect(logClass("PR_NOT_OPEN", true)).toBe("merged");
    expect(logClass("PR_NOT_OPEN", false)).toBe("refused");
    expect(logClass("PR_NOT_OPEN", null)).toBe("unknown");
  });
});

describe("which drive exits close the run tab", () => {
  it("closes on an ending that leaves nothing for a person", () => {
    const closes: DriveExitName[] = [
      "CONVERGED",
      "NOT_SETTLED",
      "PR_NOT_OPEN",
      "SINGLE_INSTANCE_LOCK",
      "DRIVE_HELD_BY_OTHER_WORKTREE",
      "QUOTA_PARKED",
      "MAILBOX_STOPPED",
      "MAILBOX_PAUSE_TIMEOUT",
      "TAKEN_OVER",
    ];
    for (const name of closes)
      expect([name, driveExitClosesTab(DRIVE_EXIT[name])]).toEqual([
        name,
        true,
      ]);
  });

  it("keeps the tab for a park, a failure or a signal", () => {
    const keeps: DriveExitName[] = [
      "INDETERMINATE",
      "UNSUPPORTED_CLI",
      "MAX_ROUNDS",
      "REVIEWER_FAILED",
      "REVIEW_SKIPPED",
      "HITL_PARKED",
      "PR_CONFLICTING",
      "WORKTREE_UNCLEAN",
      "STALLED",
      "PASS_DEADLINE",
    ];
    for (const name of keeps)
      expect([name, driveExitClosesTab(DRIVE_EXIT[name])]).toEqual([
        name,
        false,
      ]);
    expect(driveExitClosesTab(null)).toBe(false);
  });
});

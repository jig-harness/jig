/**
 * A launch the forge's spent rate limit stopped before its drive wrote a
 * ledger (`FORGE_RATE_LIMITED`, the attach's read refused) spent no re-drive
 * and no arm: within an hour of its end the next launch waits quietly, after
 * it the drive is launched again, and it is never handed to a person for
 * having been re-driven once.
 */
import { describe, expect, it } from "bun:test";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  driveHold,
  factsOf,
  settleConflictStops,
} from "../lib/actions/drive-hold.ts";
import type { LaunchClaim, LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { DrivenPr, StaleCause } from "../lib/types.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";

const WHO: LaunchClaim = {
  hostId: "",
  host: "h",
  bootId: "b",
  pid: 1,
  start: "s",
  claimedAt: "2026-01-01T00:00:00.000Z",
};

const minutesAgo = (m: number) => isoFromMs(currentMs() - m * 60_000);

/** PR #7's ledger, stopped `exit` and stale for `stale`. */
function stalePr(exit: number, stale: StaleCause): DrivenPr {
  return {
    number: 7,
    url: "",
    title: "",
    head: "h",
    class: "stale",
    why: stale.cause,
    stale,
    evidence: { generation: 3, exit, heartbeat: "x" },
  };
}

/** A re-drive of `pr` for its change, which ended `code` `ago` minutes ago. */
function redrive(pr: DrivenPr, code: number, ago: number): ReadRecord {
  const record: LaunchRecord = {
    version: 1,
    id: "20260101T000000Z-aaaaaaaa",
    token: "t",
    action: "rearm",
    repo: "o/a",
    repoPath: "/r",
    pr: 7,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: factsOf(pr),
    createdAt: minutesAgo(ago + 1),
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    redrive: pr.stale ?? null,
  };
  return {
    record,
    state: {
      kind: "ended",
      exit: { at: minutesAgo(ago), code, signal: null },
      process: { ...WHO, claimedAt: record.createdAt },
    },
    result: null,
  };
}

const LIMIT = DRIVE_EXIT.FORGE_RATE_LIMITED;
const limitStop = stalePr(LIMIT, {
  cause: `stopped ${LIMIT}, the forge's rate limit for its credential spent`,
  change: `head h, stopped ${LIMIT} at 2026-01-01T00:00:00.000Z`,
  mechanicalStop: "forge-limit",
  notBefore: "2026-01-01T01:00:00.000Z",
});
const stall = stalePr(DRIVE_EXIT.STALLED, {
  cause: `stopped ${DRIVE_EXIT.STALLED}, stalled`,
  change: `head h, stopped ${DRIVE_EXIT.STALLED}`,
  mechanicalStop: "stall",
});

describe("a launch the forge's rate limit stopped before writing a ledger", () => {
  for (const pr of [limitStop, stall])
    it(`holds the next re-drive of a ${pr.stale?.mechanicalStop} stop for an hour, never a person's`, () => {
      const records = [redrive(pr, LIMIT, 10)];
      const hold = driveHold(pr, records);
      expect(hold.kind).toBe("limited");
      expect("why" in hold ? hold.why : "").toContain("FORGE_RATE_LIMITED");
      const [settled] = settleConflictStops([pr], records);
      expect(settled?.class).toBe("stale");
    });

  for (const pr of [limitStop, stall])
    it(`re-drives a ${pr.stale?.mechanicalStop} stop again once the hour has passed`, () => {
      const records = [redrive(pr, LIMIT, 61)];
      expect(driveHold(pr, records).kind).toBe("none");
      const [settled] = settleConflictStops([pr], records);
      expect(settled?.class).toBe("stale");
    });

  it("leaves a re-drive that ended any other way spent, as before", () => {
    const records = [redrive(stall, DRIVE_EXIT.STALLED, 10)];
    expect(driveHold(stall, records).kind).toBe("redriven");
    const [settled] = settleConflictStops([stall], records);
    expect(settled?.class).toBe("needs-person");
  });
});

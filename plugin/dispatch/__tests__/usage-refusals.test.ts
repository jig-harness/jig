/**
 * A drive launch `drive.ts` refused as a usage error on the ledger facts it
 * still shows (`settleUsageRefusals`): a person's, never launched again on
 * those facts, while a record that holds its stage, new facts and a person's
 * rearm request leave the drive as it reads.
 */
import { describe, expect, it } from "bun:test";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { driveHold, settleUsageRefusals } from "../lib/actions/drive-hold.ts";
import type { LaunchClaim, LaunchRecord, ReadRecord } from "../lib/launches.ts";
import type { DrivenPr } from "../lib/types.ts";

const WHO: LaunchClaim = {
  hostId: "",
  host: "h",
  bootId: "b",
  pid: 1,
  start: "s",
  claimedAt: "2026-01-01T00:00:00.000Z",
};

const FACTS = "generation 1, exit null, heartbeat x";
const MESSAGE =
  "drive.ts --take-over: no driver holds PR #7's lock. Re-arm it without --take-over.";

function record(id: string, over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id,
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
    facts: FACTS,
    createdAt: "2026-01-01T00:00:00.000Z",
    workspace: null,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    ...over,
  };
}

function ended(
  r: LaunchRecord,
  code: number,
  at: string,
  usage?: string,
): ReadRecord {
  return {
    record: r,
    state: {
      kind: "ended",
      exit: {
        at,
        code,
        signal: null,
        ...(usage === undefined ? {} : { usage }),
      },
      process: { ...WHO, claimedAt: r.createdAt },
    },
    result: null,
  };
}

/** PR #7's ledger silent, its driver started at 00:30 by the owner below. */
const silent = (evidence: Partial<DrivenPr["evidence"]> = {}): DrivenPr => ({
  number: 7,
  url: "",
  title: "",
  head: "h",
  class: "silent",
  why: "drive ledger silent",
  evidence: {
    generation: 1,
    exit: null,
    heartbeat: "x",
    started: "2026-01-01T00:30:00.000Z",
    driverGone: true,
    ...evidence,
  },
});

/** The re-arm whose driver the ledger still names running: it ended without writing its stop. */
const owner = ended(
  record("20260101T000000Z-aaaaaaaa"),
  143,
  "2026-01-01T02:00:00.000Z",
);

/** This machine's takeover of that driver, which drive.ts refused as a usage error. */
function refusedTakeover(over: Partial<LaunchRecord> = {}): ReadRecord {
  return ended(
    record("20260101T030000Z-bbbbbbbb", {
      action: "takeover",
      createdAt: "2026-01-01T03:00:00.000Z",
      ...over,
    }),
    DRIVE_EXIT.UNSUPPORTED_CLI,
    "2026-01-01T03:00:05.000Z",
    MESSAGE,
  );
}

describe("a drive launch drive.ts refused as a usage error", () => {
  it("is a person's on the same ledger facts, with the drive's message, and is not taken over again", () => {
    const records = [owner, refusedTakeover()];
    // Without the settlement, the ended owner is taken over again.
    expect(driveHold(silent(), records).kind).toBe("takeover");
    const [settled] = settleUsageRefusals([silent()], records);
    expect(settled?.class).toBe("needs-person");
    expect(settled?.why).toContain(
      "launch record 20260101T030000Z-bbbbbbbb (takeover) ended",
    );
    expect(settled?.why).toContain(MESSAGE);
    expect(settled?.evidence).toMatchObject({
      usageRefusal: "20260101T030000Z-bbbbbbbb",
      usageMessage: MESSAGE,
      driverGone: false,
      settled: true,
    });
    expect(driveHold(settled as DrivenPr, records).kind).toBe("none");
  });

  it("settles a re-arm refused the same way", () => {
    const rearm = ended(
      record("20260101T030000Z-cccccccc", {
        createdAt: "2026-01-01T03:00:00.000Z",
        facts: "generation 1, exit 8, heartbeat x",
      }),
      DRIVE_EXIT.UNSUPPORTED_CLI,
      "2026-01-01T03:00:05.000Z",
    );
    const drive: DrivenPr = {
      ...silent({ exit: 8 }),
      class: "re-armable",
    };
    const [settled] = settleUsageRefusals([drive], [rearm]);
    expect(settled?.class).toBe("needs-person");
    expect(settled?.evidence.usageMessage).toBe("its message was not kept");
  });

  it("leaves the drive as it reads while a record still holds its stage", () => {
    const pending: ReadRecord = {
      record: record("20260101T040000Z-dddddddd", {
        action: "takeover",
        createdAt: "2026-01-01T00:10:00.000Z",
      }),
      state: { kind: "pending" },
      result: null,
    };
    const [left] = settleUsageRefusals(
      [silent()],
      [owner, pending, refusedTakeover()],
    );
    expect(left?.class).toBe("silent");
  });

  it("launches again once the ledger moves, or a person asks for a re-arm", () => {
    const records = [owner, refusedTakeover()];
    const [moved] = settleUsageRefusals([silent({ generation: 2 })], records);
    expect(moved?.class).toBe("silent");
    const [asked] = settleUsageRefusals([silent({ rearm: true })], records);
    expect(asked?.class).toBe("silent");
  });

  it("leaves any other exit to the rules that already answer it", () => {
    const other = ended(
      record("20260101T030000Z-eeeeeeee", {
        action: "takeover",
        createdAt: "2026-01-01T03:00:00.000Z",
      }),
      DRIVE_EXIT.INDETERMINATE,
      "2026-01-01T03:00:05.000Z",
    );
    const [left] = settleUsageRefusals([silent()], [owner, other]);
    expect(left?.class).toBe("silent");
  });
});

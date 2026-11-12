/**
 * A dispatched pickup's claim is noted on its launch record where it is made,
 * so the tick counts the item as its pickup's even when the pass claimed and
 * ended between two ticks and no tick read the item in progress meanwhile.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_VARIABLE } from "../../shared/launched-session.ts";
import {
  type LaunchRecord,
  type ReadRecord,
  readRecord,
  writeRecord,
} from "../lib/launches.ts";
import { NOT_DISPATCHED, notePickupClaim } from "../lib/pickup-claim.ts";
import { planPickups } from "../lib/plan-pickups.ts";
import { closeStateDb } from "../lib/state.ts";
import type { DispatchSection } from "../lib/types.ts";

const ID = "20261111T060000Z-aaaaaaaa";
const NOW = Date.parse("2026-11-11T08:00:00Z");
const HOUR = 3_600_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-pickup-claim-"));
  dirs.push(dir);
  return dir;
}

function pickup(over: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    version: 1,
    id: ID,
    token: "t",
    action: "pickup",
    repo: "o/a",
    repoPath: "/r",
    pr: null,
    account: "a",
    vendor: "claude",
    configDir: "/c",
    wallBackoffMs: 1,
    replaces: null,
    facts: "",
    createdAt: "2026-11-11T06:00:00.000Z",
    workspace: null,
    attempts: [],
    item: "#7",
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    servedPerson: "alex",
    ...over,
  };
}

const dispatched = { [LAUNCH_VARIABLE]: ID };

describe("notePickupClaim", () => {
  it("notes the claim on the pickup record the pass runs under", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    expect(notePickupClaim("#7", dispatched, dir)).toEqual({
      ok: true,
      value: { noted: true, record: ID },
    });
    expect(readRecord(ID, dir)?.claimedItems).toEqual(["#7"]);
  });

  it("notes a batch member, and keeps the members already noted", () => {
    const dir = root();
    writeRecord(
      pickup({
        batchItems: [
          { key: "#7", person: "alex" },
          { key: "#8", person: "alex" },
        ],
        claimedItems: ["#7"],
      }),
      dir,
    );
    notePickupClaim("#8", dispatched, dir);
    expect(readRecord(ID, dir)?.claimedItems).toEqual(["#7", "#8"]);
  });

  it("keeps a claim when a stale tick record is written afterwards", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    notePickupClaim("#7", dispatched, dir);
    // `callLaunch` can finish with this snapshot after the pickup has claimed.
    writeRecord(
      pickup({
        attempts: [
          { at: "2026-11-11T06:01:00Z", outcome: "sent", detail: "started" },
        ],
      }),
      dir,
    );
    expect(readRecord(ID, dir)?.claimedItems).toEqual(["#7"]);
  });

  it("notes nothing outside a dispatched pass", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    expect(notePickupClaim("#7", {}, dir)).toEqual({
      ok: true,
      value: { noted: false, why: NOT_DISPATCHED },
    });
    expect(readRecord(ID, dir)?.claimedItems).toBeUndefined();
  });

  it("refuses an item its pickup does not start, and a record that is not a pickup's", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    const other = notePickupClaim("#9", dispatched, dir);
    expect(other.ok && other.value).toMatchObject({ noted: false });
    expect(readRecord(ID, dir)?.claimedItems).toBeUndefined();

    const followup = root();
    writeRecord(pickup({ action: "followup", item: null, pr: 7 }), followup);
    const refused = notePickupClaim("#7", dispatched, followup);
    expect(refused.ok && refused.value).toMatchObject({
      noted: false,
      why: expect.stringContaining("not a pickup's"),
    });
  });

  it("makes a served item a pickup claimed and ended between two ticks a stall", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    notePickupClaim("#7", dispatched, dir);
    const record = readRecord(ID, dir);
    if (record === null) throw new Error("the record is gone");
    const ended: ReadRecord = {
      record,
      state: {
        kind: "ended",
        exit: { at: "2026-11-11T06:05:00Z", code: 0, signal: null },
        process: null,
      },
      result: "failed",
    };
    const plan = planPickups({
      slug: "o/a",
      section: {
        stalledAfterMs: HOUR / 2,
        blockedAfterMs: HOUR,
      } as DispatchSection,
      pickups: [],
      claimed: [
        { key: "#7", title: "task", state: "In Progress", served: true },
      ],
      sessions: { ok: true, source: "fake", workspaces: [] },
      launches: [ended],
      idleSince: new Map([["#7", NOW - 2 * HOUR]]),
      nowMs: NOW,
    });
    expect(plan.actions).toEqual([
      expect.objectContaining({ target: "#7", cause: "stalled" }),
    ]);
  });
});

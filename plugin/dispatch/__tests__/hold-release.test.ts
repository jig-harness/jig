/**
 * An item a person held (`jig:hold`) and then released is picked up again:
 * the hold ends the stale record of the pickup that ended without claiming
 * it, while a claimed item's record outlives any hold.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickupHold,
  recordsWanted,
  releaseEnded,
} from "../lib/actions/pickup-hold.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import { PERSON_HOLD } from "../lib/queue-rank.ts";
import { closeStateDb } from "../lib/state.ts";
import type { Unplaced } from "../lib/types.ts";
import { SLUG } from "./fixtures.ts";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-hold-release-"));
  roots.push(dir);
  return dir;
}

/** A pickup of `item` that ended without claiming it. */
function endedPickup(item: string): ReadRecord {
  return {
    record: {
      id: "2026-11-11T06-00-00-000Z-test",
      createdAt: "2026-11-11T06:00:00Z",
      action: "pickup",
      repo: SLUG,
      item,
      pr: null,
      released: false,
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-11T06:30:00Z", code: 0, signal: null },
      process: null,
    },
    result: "failed",
  };
}

const held = (target: string): Unplaced => ({
  target,
  record: "tracker",
  reason: PERSON_HOLD,
});

/** One tick's release, as the tick plans it: the pickups wanted, the items left out, and the claimed items. */
function tick(
  records: ReadRecord[],
  dir: string,
  read: { pickups?: string[]; unplaced?: Unplaced[]; claimed?: string[] },
): void {
  const pickups = (read.pickups ?? []).map((key) => ({ key }));
  releaseEnded(
    records,
    SLUG,
    recordsWanted(pickups, read.unplaced ?? [], records),
    new Set(read.claimed ?? []),
    new Set(read.pickups ?? []),
    dir,
  );
}

describe("an item held and then released", () => {
  it("is wanted again at the next tick: the hold ended its stale pickup record", () => {
    const dir = root();
    const records = [endedPickup("#7")];
    // The pickup ended without claiming: the record holds the wanted item.
    tick(records, dir, { pickups: ["#7"] });
    expect(pickupHold("#7", records).kind).toBe("ended");
    // A person holds it.
    tick(records, dir, { unplaced: [held("#7")] });
    // And releases it: it is a pickup again.
    tick(records, dir, { pickups: ["#7"] });
    expect(pickupHold("#7", records).kind).toBe("none");
  });

  it("keeps a claimed item's record through a hold", () => {
    const dir = root();
    const records = [endedPickup("#7")];
    tick(records, dir, { unplaced: [held("#7")], claimed: ["#7"] });
    expect(records[0]?.record.released).toBe(false);
    expect(pickupHold("#7", records).kind).toBe("ended");
  });

  it("keeps the record of a pickup that recorded done through a hold", () => {
    const dir = root();
    const records = [{ ...endedPickup("#7"), result: "done" as const }];
    tick(records, dir, { unplaced: [held("#7")] });
    expect(records[0]?.record.released).toBe(false);
  });

  it("keeps the record of an item left out for another reason", () => {
    const dir = root();
    const records = [endedPickup("#7")];
    tick(records, dir, {
      unplaced: [
        { target: "#7", record: "tracker", reason: "who assigned it is a bot" },
      ],
    });
    expect(records[0]?.record.released).toBe(false);
  });

  it("is not kept by an older pickup that finished and was released", () => {
    const dir = root();
    const done = {
      ...endedPickup("#7"),
      result: "done" as const,
    };
    done.record = {
      ...done.record,
      id: "old",
      createdAt: "2026-11-10T06:00:00Z",
      released: true,
    } as LaunchRecord;
    const records = [done, endedPickup("#7")];
    tick(records, dir, { unplaced: [held("#7")] });
    expect(records[1]?.record.released).toBe(true);
  });

  it("releases a held member of a failed batch alone, while its sibling keeps the record", () => {
    const dir = root();
    const batch = endedPickup("#7");
    batch.record = {
      ...batch.record,
      batchItems: [{ key: "#7" }, { key: "#8" }],
    } as unknown as LaunchRecord;
    const records = [batch];
    tick(records, dir, { pickups: ["#8"], unplaced: [held("#7")] });
    expect(batch.record.released).toBe(false);
    expect(batch.record.releasedItems).toEqual(["#7"]);
    expect(pickupHold("#7", records).kind).toBe("none");
    expect(pickupHold("#8", records).kind).toBe("ended");
  });

  it("releases a held member of a batch alone while a sibling is claimed", () => {
    const dir = root();
    const batch = endedPickup("#7");
    batch.record = {
      ...batch.record,
      batchItems: [{ key: "#7" }, { key: "#8" }],
    } as unknown as LaunchRecord;
    const records = [batch];
    tick(records, dir, { claimed: ["#8"], unplaced: [held("#7")] });
    expect(batch.record.releasedItems).toEqual(["#7"]);
    expect(batch.record.released).toBe(false);
  });

  it("recognizes a hold the ready pool words with its state", () => {
    const dir = root();
    const records = [endedPickup("#7")];
    tick(records, dir, {
      unplaced: [
        {
          target: "#7",
          record: "tracker",
          reason: `in the ready pool (Todo), but ${PERSON_HOLD}`,
        },
      ],
    });
    expect(records[0]?.record.released).toBe(true);
  });
});

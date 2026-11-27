/**
 * What waits on a person and what the tick settles itself. A pickup hold
 * whose dependency the tick reads is a Queue row; a hold a person releases
 * is listed among what waits on one. A whole-batch question on an anchor an
 * open pull request carries releases the members its pass never claimed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseEnded } from "../lib/actions/pickup-hold.ts";
import { buildLine } from "../lib/line.ts";
import type { LaunchRecord, ReadRecord } from "../lib/launches.ts";
import {
  type PersonPickupHold,
  selfChecked,
  unplacedQueueFields,
} from "../lib/person-pickup-holds.ts";
import { closeStateDb } from "../lib/state.ts";
import { input, report } from "./line-fixtures.ts";

const AT = "2026-11-03T12:25:00.000Z";

function hold(extra: Partial<PersonPickupHold> = {}): PersonPickupHold {
  return {
    item: "#240",
    by: "maintainer",
    at: AT,
    title: "t",
    url: null,
    ...extra,
  };
}

describe("a pickup hold the tick checks itself", () => {
  it("is one whose dependency is readable and has not settled", () => {
    expect(selfChecked(hold({ condition: { kind: "pr-merged", pr: 7 } }))).toBe(
      true,
    );
    expect(
      selfChecked(hold({ condition: { kind: "item-closed", item: "#9" } })),
    ).toBe(true);
  });

  it("is not a hold with no dependency, an unreadable one, or one that can no longer clear", () => {
    expect(selfChecked(hold())).toBe(false);
    expect(selfChecked(hold({ unreadableCondition: true }))).toBe(false);
    expect(
      selfChecked(
        hold({
          condition: { kind: "pr-merged", pr: 7 },
          settled: "closed-unmerged",
        }),
      ),
    ).toBe(false);
  });

  it("is a held Queue row with no person's marker, while a person's hold keeps its marker", () => {
    const reason = "held by maintainer: waiting for PR #7 to merge";
    const line = buildLine(
      input({
        reports: [
          report({
            unplaced: [
              { target: "#240", record: "tracker", reason, selfChecked: true },
              {
                target: "#241",
                record: "tracker",
                reason: "held by maintainer",
                pickupHold: { by: "maintainer", at: AT },
              },
              { target: "#242", record: "tracker", reason: "refused" },
            ],
          } as Parameters<typeof report>[0]),
        ],
      }),
    );
    const rows = new Map(line.queue.map((q) => [q.target, q]));
    expect(rows.get("#240")).toMatchObject({
      group: "held",
      source: "held",
      why: reason,
    });
    expect(rows.get("#240")?.pickupHold).toBeUndefined();
    expect(rows.get("#241")).toMatchObject({
      group: "held",
      pickupHold: { by: "maintainer", at: AT },
    });
    expect(rows.get("#242")).toMatchObject({ group: "never" });
  });

  it("places an unmarked unplaced item as refused", () => {
    expect(unplacedQueueFields({ target: "#1", reason: "r" })).toMatchObject({
      source: "assigned",
      group: "never",
    });
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

const SLUG = "example-org/example-repo";

/** An ended batch of three whose pass asked a question naming no member, and claimed none. */
function wholeBatchQuestion(): ReadRecord {
  const record = {
    id: "2026-11-12T16-40-41-000Z-batch",
    account: "a",
    action: "pickup",
    repo: SLUG,
    item: "#923",
    pr: null,
    workspace: null,
    batchItems: ["#923", "#924", "#925"].map((key) => ({ key })),
    createdAt: "2026-11-12T16:40:41.000Z",
    released: false,
    claimedItems: ["#923"],
  } as unknown as LaunchRecord;
  return {
    record,
    state: {
      kind: "ended",
      exit: {
        at: "2026-11-12T17:22:00Z",
        code: 0,
        signal: null,
        said: "Question: Should the batch follow the shared approach?\n",
      },
      process: null,
    },
    result: "failed",
  } as unknown as ReadRecord;
}

function releaseWith(carried: ReadonlySet<string>): ReadRecord {
  const dir = mkdtempSync(join(tmpdir(), "jig-self-checked-"));
  roots.push(dir);
  const read = wholeBatchQuestion();
  releaseEnded(
    [read],
    SLUG,
    new Set(["#924", "#925"]),
    new Set(["#923"]),
    new Set(["#924", "#925"]),
    dir,
    new Set(),
    false,
    carried,
  );
  return read;
}

describe("the members of a batch whose whole-batch question sits on a carried anchor", () => {
  it("are released while the anchor keeps its claim", () => {
    const read = releaseWith(new Set(["#923"]));
    expect(read.record.releasedItems).toEqual(["#924", "#925"]);
    expect(read.record.released).toBe(false);
  });

  it("stay held while no open pull request carries the anchor", () => {
    const read = releaseWith(new Set());
    expect(read.record.releasedItems).toBeUndefined();
  });
});

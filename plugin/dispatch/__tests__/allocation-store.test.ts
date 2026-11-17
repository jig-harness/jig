/**
 * The allocation records: a claim's charge, written by the claim path in the
 * claim's transaction and counted once per claim id; the week's row, written
 * once; the lanes' epochs; and the peripheral debt carried across a week
 * boundary into the next ranking.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCH_VARIABLE } from "../../shared/launched-session.ts";
import { rank } from "../../shared/priorities/ranker.ts";
import { DEFAULT_WEIGHTS } from "../../shared/priorities/lanes.ts";
import {
  claimId,
  openWeek,
  pruneCharges,
  recordEpochs,
  saveRanking,
  weekCharges,
  weekRow,
  writeCharge,
} from "../lib/allocation-store.ts";
import { type LaunchRecord, writeRecord } from "../lib/launches.ts";
import { notePickupClaim } from "../lib/pickup-claim.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import {
  input,
  objectiveWork,
} from "../../shared/__tests__/priorities-fixtures.ts";

const ID = "20261116T060000Z-aaaaaaaa";
/** Wednesday of the week opening Monday 2026-11-16. */
const NOW = Date.parse("2026-11-18T08:00:00Z");
const PREVIOUS = Date.parse("2026-11-11T08:00:00Z");
const DEFAULTS = {
  weights: { ...DEFAULT_WEIGHTS },
  source: "defaults",
  problems: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-allocation-"));
  dirs.push(dir);
  return dir;
}

function pickup(): LaunchRecord {
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
    createdAt: "2026-11-16T06:00:00.000Z",
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
  };
}

function charges(dir: string): Array<Record<string, unknown>> {
  return stateDb(dir).query("SELECT * FROM allocation_charge").all() as Array<
    Record<string, unknown>
  >;
}

describe("a claim's charge", () => {
  it("is written by the claim path with the lane the newest ranking gave the item and the weights read, once per claim id however often the claim replays", () => {
    const dir = root();
    const home = root();
    writeFileSync(
      join(home, "weights.local.yaml"),
      "lanes:\n  peripheral: 25\n  core: 50\n  tactical: 25\n  bug-other: 0\n",
    );
    writeRecord(pickup(), dir);
    saveRanking(
      stateDb(dir),
      "o/a",
      input(),
      rank(input()),
      {
        "#7": {
          lane: "peripheral",
          objective: "side",
          owners: { repository: "repository:o/a:side" },
        },
      },
      NOW,
    );
    const env = { [LAUNCH_VARIABLE]: ID, JIG_HOME: home };
    for (let i = 0; i < 3; i++) notePickupClaim("#7", env, dir);
    const rows = charges(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      claim_id: claimId(ID, "#7"),
      lane: "peripheral",
      peripheral_share: 0.25,
      owners: JSON.stringify({ repository: "repository:o/a:side" }),
    });
    expect(JSON.parse(String(rows[0]?.weights))).toEqual({
      "bug-other": 0,
      core: 50,
      tactical: 25,
      peripheral: 25,
    });
  });

  it("is not written for a claim the record refuses", () => {
    const dir = root();
    writeRecord(pickup(), dir);
    notePickupClaim("#9", { [LAUNCH_VARIABLE]: ID, JIG_HOME: root() }, dir);
    expect(charges(dir)).toEqual([]);
  });

  it("is unallocated with no peripheral share when no ranking classified the item", () => {
    const dir = root();
    const db = stateDb(dir);
    expect(
      writeCharge(
        db,
        { claimId: "x:#1", repo: "o/a", item: "#1", atMs: NOW },
        DEFAULTS,
      ),
    ).toBe(true);
    expect(
      writeCharge(
        db,
        { claimId: "x:#1", repo: "o/a", item: "#1", atMs: NOW + 1 },
        DEFAULTS,
      ),
    ).toBe(false);
    expect(charges(dir)).toMatchObject([
      { lane: "unallocated", peripheral_share: 0 },
    ]);
  });
});

function charge(dir: string, n: number, lane: string, atMs: number): void {
  const db = stateDb(dir);
  saveRanking(
    db,
    "o/a",
    input(),
    rank(input()),
    { [`#${n}`]: { lane: lane as "core", objective: null, owners: {} } },
    atMs,
  );
  writeCharge(
    db,
    { claimId: `c:${n}`, repo: "o/a", item: `#${n}`, atMs },
    DEFAULTS,
  );
}

describe("the week", () => {
  it("opens with no debt, and says so, when there is nothing to derive it from", () => {
    const week = openWeek(stateDb(root()), NOW);
    expect(week).toMatchObject({ week: "2026-11-16", d0: 0, charges: [] });
    expect(week.d0Reason).toContain("no row for the week before");
  });

  it("carries the unmet peripheral floor across the boundary, and the next ranking owes it", () => {
    const dir = root();
    // Last week: 14 weighted starts, an Urgent one and a High bug, no peripheral work.
    for (let i = 0; i < 14; i++) charge(dir, i, "core", PREVIOUS + i);
    charge(dir, 100, "urgent", PREVIOUS + 100);
    charge(dir, 101, "bug-high", PREVIOUS + 101);
    const week = openWeek(stateDb(dir), NOW);
    expect(weekRow(stateDb(dir), "2026-11-09")).toMatchObject({
      n: 14,
      p: 0,
      d0: 0,
      f: 1.4,
      nextDebt: 1.4,
    });
    expect(week.d0).toBe(1.4);
    const out = rank(
      input({
        snapshot: { readAt: "t", items: objectiveWork(2) },
        week,
        capacity: { starts: 1 },
      }),
    );
    expect(out.shortlist[0]).toMatchObject({ lane: "peripheral" });
    expect(out.floor.d0).toBe(1.4);
  });

  it("writes the completed week's row once and never rewrites it", () => {
    const dir = root();
    charge(dir, 1, "peripheral", PREVIOUS);
    openWeek(stateDb(dir), NOW);
    const first = weekRow(stateDb(dir), "2026-11-09");
    // A late charge for the closed week changes nothing already written.
    charge(dir, 2, "core", PREVIOUS + 5);
    openWeek(stateDb(dir), NOW + 3_600_000);
    expect(weekRow(stateDb(dir), "2026-11-09")).toEqual(first);
  });

  it("counts Urgent and High-bug starts nowhere in N", () => {
    const dir = root();
    charge(dir, 1, "urgent", NOW);
    charge(dir, 2, "bug-high", NOW + 1);
    charge(dir, 3, "core", NOW + 2);
    const week = openWeek(stateDb(dir), NOW + 3);
    expect(week.charges.map((c) => c.lane)).toEqual([
      "urgent",
      "bug-high",
      "core",
    ]);
    const out = rank(
      input({
        snapshot: { readAt: "t", items: objectiveWork(2) },
        week,
        capacity: { starts: 1 },
      }),
    );
    // One weighted start so far: N is 1.
    expect(out.shortlist[0]?.reason).toContain("(N 1,");
  });

  it("keeps charges for at least two weeks", () => {
    const dir = root();
    const db = stateDb(dir);
    charge(dir, 1, "core", NOW - 15 * 86_400_000);
    charge(dir, 2, "core", NOW - 30 * 86_400_000);
    pruneCharges(db, NOW);
    expect(charges(dir).map((r) => r.item)).toEqual(["#1"]);
    expect(weekCharges(db, "2026-11-02")).toHaveLength(1);
  });
});

describe("the lanes' epochs", () => {
  it("start a lane that becomes ready mid-week with no catch-up, and move the revision", () => {
    const dir = root();
    const db = stateDb(dir);
    const empty = openWeek(db, NOW);
    const first = recordEpochs(
      db,
      empty,
      new Set(["core", "tactical"]),
      "h1",
      NOW,
    );
    expect(first.startN).toEqual({});
    for (let i = 0; i < 3; i++) charge(dir, i, "core", NOW + i);
    const week = openWeek(db, NOW + 10);
    const second = recordEpochs(
      db,
      week,
      new Set(["core", "tactical", "peripheral"]),
      "h2",
      NOW + 10,
    );
    expect(second.startN).toEqual({ peripheral: 3 });
    expect(second.revision).toBeGreaterThan(first.revision);
    // Unchanged readiness records nothing new.
    expect(
      recordEpochs(
        db,
        week,
        new Set(["core", "tactical", "peripheral"]),
        "h3",
        NOW + 20,
      ).revision,
    ).toBe(second.revision);
  });
});

/**
 * The design's sample week, reproduced launch by launch: one tick per launch,
 * each charge appended as the claim path would, each lane's epoch recorded
 * when it becomes ready, and the week closed at the end.
 */
import { describe, expect, test } from "bun:test";
import { type LaneEpochs, rank, readyLanes } from "../priorities/ranker.ts";
import type { SnapshotItem } from "../priorities/snapshot.ts";
import { closeWeek, type WeekCharge } from "../priorities/week.ts";
import type { WeightedLane } from "../priorities/lanes.ts";
import { input, item, objectiveWork } from "./priorities-fixtures.ts";

const ROWS: Array<
  [number, string, number | null, number | null, number | null, string]
> = [
  [1, "core", 0, 0, 0.7, "largest deficit, 0.5"],
  [2, "tactical", 1, 0, 0.8, "largest deficit, 0.5"],
  [3, "urgent", null, null, null, "first; not counted in N"],
  [4, "core", 2, 0, 0.9, "largest deficit, 0.5"],
  [5, "bug-other", 3, 0, 1.0, "lent; largest deficit, 0.6"],
  [6, "core", 4, 0, 1.1, "lent; largest deficit, 0.5"],
  [7, "tactical", 5, 0, 1.2, "lent; largest deficit, 0.5"],
  [
    8,
    "bug-high",
    null,
    null,
    null,
    "ahead of the weighted lanes; not counted in N",
  ],
  [9, "peripheral", 6, 0, 1.3, "owed a whole start"],
  [10, "core", 7, 1, 0.4, "largest deficit, 1"],
  [11, "core", 8, 1, 0.5, "largest deficit, 0.5"],
  [12, "tactical", 9, 1, 0.6, "largest deficit, 0.5"],
  [13, "bug-other", 10, 1, 0.7, "largest deficit, 0.65"],
  [14, "core", 11, 1, 0.8, "largest deficit, 1"],
  [15, "core", 12, 1, 0.9, "largest deficit, 0.5"],
  [16, "peripheral", 13, 1, 1.0, "owed a whole start"],
];

/** The previous week: 16 weighted starts, one of them peripheral, no opening debt. */
function previousWeek(): WeekCharge[] {
  return Array.from({ length: 16 }, (_, i) => ({
    claimId: `prev-${i}`,
    lane: i === 0 ? "peripheral" : "core",
    objective: null,
    peripheralShare: 0.1,
    atMs: i,
  }));
}

describe("the design's sample week", () => {
  test("16 launches end core 7, tactical 3, peripheral 2, bug-other 2 and open the next week at zero debt", () => {
    const opening = closeWeek("2026-11-09", previousWeek(), 0);
    expect(opening.nextDebt).toBe(0.6);
    const pools: SnapshotItem[] = [
      ...objectiveWork(20, ["core", "tactical"]),
      ...Array.from({ length: 6 }, (_, i) =>
        item(`#40${i}`, { type: "bug", priority: 3 }),
      ),
    ];
    const charges: WeekCharge[] = [];
    const startN: Partial<Record<WeightedLane, number>> = {};
    let ready = new Set<WeightedLane>();
    let revision = 0;
    for (const [launch, lane, n, p, owed, why] of ROWS) {
      const items = [...pools];
      if (launch >= 9) items.push(...objectiveWork(5, ["peripheral"]));
      if (launch === 3) items.push(item("#500", { priority: 1 }));
      if (launch === 8) items.push(item("#600", { type: "bug", priority: 2 }));
      const base = input({
        snapshot: { readAt: `launch-${launch}`, items },
        capacity: { starts: 1 },
        week: {
          week: "2026-11-16",
          d0: opening.nextDebt,
          d0Reason: null,
          charges: [...charges],
        },
      });
      const weighted = charges.filter(
        (c) => c.lane !== "urgent" && c.lane !== "bug-high",
      ).length;
      const now = readyLanes(base);
      for (const l of now)
        if (!ready.has(l) && launch > 1) {
          startN[l] = weighted;
          revision++;
        }
      ready = now;
      const epochs: LaneEpochs = { revision, startN: { ...startN } };
      const out = rank({ ...base, epochs });
      const first = out.shortlist[0];
      if (first === undefined)
        throw new Error(`launch ${launch} proposed nothing`);
      expect(`${launch} ${first.lane}`).toBe(`${launch} ${lane}`);
      expect(first.reason).toContain(why);
      if (n !== null)
        expect(first.reason).toContain(`(N ${n}, P ${p}, owed ${owed})`);
      charges.push({
        claimId: `claim-${launch}`,
        lane: first.lane,
        objective: first.owners.repository ?? null,
        peripheralShare: 0.1,
        atMs: launch,
      });
      const at = pools.findIndex((i) => i.key === first.key);
      if (at >= 0) pools.splice(at, 1);
    }
    const counts = (lane: string) =>
      charges.filter((c) => c.lane === lane).length;
    expect([
      counts("core"),
      counts("tactical"),
      counts("peripheral"),
      counts("bug-other"),
    ]).toEqual([7, 3, 2, 2]);
    const closed = closeWeek("2026-11-16", charges, opening.nextDebt);
    expect(closed).toMatchObject({ n: 14, p: 2, d0: 0.6, f: 1.4, nextDebt: 0 });
  });

  test("had peripheral work stayed blocked all week, the next week would open owing F and drop the debt carried in", () => {
    const charges: WeekCharge[] = Array.from({ length: 14 }, (_, i) => ({
      claimId: `c${i}`,
      lane: "core",
      objective: null,
      peripheralShare: 0.1,
      atMs: i,
    }));
    expect(closeWeek("2026-11-16", charges, 0.6).nextDebt).toBe(1.4);
  });
});

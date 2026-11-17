/** Builders for the priorities ranker's tests. */
import { DEFAULT_WEIGHTS, type WeightedLane } from "../priorities/lanes.ts";
import type { PrioritiesRecord } from "../priorities/record.ts";
import type { RankerInput } from "../priorities/ranker.ts";
import type { SnapshotItem } from "../priorities/snapshot.ts";
import type { LaneWeights } from "../priorities/weights.ts";

export const SCOPE = "acme/widgets";

export function item(
  key: string,
  over: Partial<SnapshotItem> = {},
): SnapshotItem {
  return {
    scope: SCOPE,
    key,
    title: `item ${key}`,
    priority: 3,
    type: "feature",
    state: "ready",
    isEpic: false,
    parent: null,
    children: [],
    blockers: [],
    assigned: true,
    labels: [],
    excluded: null,
    gaps: [],
    ...over,
  };
}

export function epic(
  key: string,
  over: Partial<SnapshotItem> = {},
): SnapshotItem {
  return item(key, { isEpic: true, state: "in_progress", ...over });
}

/** A repository record with one objective per class, each selecting one epic. */
export function record(over: Partial<PrioritiesRecord> = {}): PrioritiesRecord {
  return {
    level: "repository",
    scope: SCOPE,
    revision: 1,
    objectives: [
      objective("core-goal", "core", ["#100"]),
      objective("tactical-goal", "tactical", ["#200"]),
      objective("peripheral-goal", "peripheral", ["#300"]),
    ],
    ...over,
  };
}

export function objective(
  id: string,
  cls: "core" | "tactical" | "peripheral",
  keys: string[],
  share?: number,
): PrioritiesRecord["objectives"][number] {
  return {
    id,
    class: cls,
    purpose: `the ${id} purpose`,
    endState: `the ${id} end state`,
    owner: "maintainers",
    epics: [{ scope: SCOPE, keys }],
    ...(share === undefined ? {} : { share }),
  };
}

export function weights(
  over: Partial<Record<WeightedLane, number | null>> = {},
): LaneWeights {
  return {
    weights: { ...DEFAULT_WEIGHTS, ...over },
    source: "defaults",
    problems: [],
  };
}

export function input(over: Partial<RankerInput> = {}): RankerInput {
  return {
    asOf: "2026-11-17T06:00:00.000Z",
    snapshot: { readAt: "2026-11-17T06:00:00.000Z", items: [] },
    records: [record()],
    allocationBlocked: null,
    weights: weights(),
    capacity: { starts: 5 },
    epochs: { revision: 0, startN: {} },
    week: { week: "2026-11-16", d0: 0, d0Reason: null, charges: [] },
    ...over,
  };
}

/** The three objective epics and `count` ready children under each. */
export function objectiveWork(
  count: number,
  lanes: Array<"core" | "tactical" | "peripheral"> = [
    "core",
    "tactical",
    "peripheral",
  ],
): SnapshotItem[] {
  const epics = { core: "#100", tactical: "#200", peripheral: "#300" } as const;
  const out: SnapshotItem[] = [];
  for (const lane of lanes) {
    out.push(epic(epics[lane]));
    for (let i = 1; i <= count; i++)
      out.push(
        item(`${epics[lane].slice(0, 2)}${String(i).padStart(2, "0")}`, {
          parent: epics[lane],
        }),
      );
  }
  return out;
}

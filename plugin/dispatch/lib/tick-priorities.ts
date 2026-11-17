/**
 * The tick's report-only ranking of declared priorities
 * ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)).
 * After each repository's plan, on the host that owns the repository, it
 * builds the tracker snapshot from the pickups the tick already read (no
 * further tracker call), reads the repository record and the host's weights
 * file again and keeps them for the tick (`preparePriorities`). Once every
 * repository is planned, `rankPriorities` opens the week (writing the
 * completed week's row once), records the lanes' ready transitions once for
 * the host, from the union of every prepared repository's ready lanes, then
 * ranks each repository, keeps its newest ranking for the claim path's charge
 * and puts the shortlist on its report. Dispatch's selection reads none of it
 * unless the host opts in (`priorities.enforce` in the machine file): then the
 * ranking places every pickup the tick read, and the repository's pickups are
 * reordered to start in its order, a lane out of rotation starting nothing
 * (`priorities-order.ts`). A ranking that fails leaves the plan's own order.
 */
import type { Database } from "bun:sqlite";
import { currentIso } from "../../shared/time.ts";
import type { WeightedLane } from "../../shared/priorities/lanes.ts";
import { hashOf } from "../../shared/priorities/hash.ts";
import {
  rank,
  type RankerInput,
  type RankerOutput,
  readyLanes,
} from "../../shared/priorities/ranker.ts";
import type {
  SnapshotItem,
  TrackerSnapshot,
} from "../../shared/priorities/snapshot.ts";
import { ancestorItem, snapshotItem } from "./priorities-snapshot.ts";
import {
  type LaneWeights,
  readLaneWeights,
  weightsFilePath,
} from "../../shared/priorities/weights.ts";
import { classify } from "../../shared/priorities/classify.ts";
import {
  type ItemClass,
  openWeek,
  pruneCharges,
  pruneEpochs,
  recordEpochs,
  saveRanking,
} from "./allocation-store.ts";
import {
  readRepositoryRecord,
  type PrioritiesRecordRead,
} from "./priorities-read.ts";
import { inTransaction, stateDb } from "./state.ts";
import { type EnforcedOrder, enforcePickupOrder } from "./priorities-order.ts";
import { failureText } from "./text.ts";
import type { RepoReport, Unplaced, WantedItem } from "./types.ts";

/** How many prospective starts the report-only shortlist proposes. */
const SHORTLIST_DEPTH = 10;

/** The priorities part of a repository's report. */
export interface PrioritiesReport {
  record: Omit<PrioritiesRecordRead, "record" | "complete"> & {
    revision: number | null;
  };
  weights: { source: string; problems: string[] };
  ranking: RankerOutput;
  /** Under the host's `priorities.enforce`: the order the pickups start in, and the pickups the ranking held back. */
  enforced?: EnforcedOrder;
}

/** What the ranking reads from the tick. */
export interface PrioritiesTickInput {
  slug: string;
  path: string;
  defaultBranch: string;
  /** The tracker scope the repository's items are keyed in. */
  scope: string;
  pickups: readonly WantedItem[];
  unplaced: readonly Unplaced[];
  /** Whether the tracker reading was whole: `false` when a queue or item read failed or was cut short, which no unplaced row need say. */
  trackerComplete: boolean;
  nowMs: number;
  /** The tick's deadline (epoch milliseconds); the record read stops there. */
  deadlineMs?: number;
  env?: Record<string, string | undefined>;
  stateRoot?: string;
  /** Whether the host's `priorities.enforce` orders the pickups by the ranking. */
  enforce?: boolean;
}

/** One repository's inputs to the tick's ranking, read after its plan. */
export interface PreparedPriorities {
  report: RepoReport;
  slug: string;
  read: PrioritiesRecordRead;
  trackerComplete: boolean;
  weights: LaneWeights;
  snapshot: TrackerSnapshot;
  records: RankerInput["records"];
  allocationBlocked: string | null;
  stateRoot?: string;
}

/** Read one repository's ranking inputs; the prepared inputs, or `null` with why on its report. */
export function preparePriorities(
  report: RepoReport,
  input: PrioritiesTickInput,
): PreparedPriorities | null {
  try {
    const read = readRepositoryRecord(
      input.path,
      input.defaultBranch,
      input.nowMs,
      input.deadlineMs,
    );
    return {
      report,
      slug: input.slug,
      read,
      trackerComplete: input.trackerComplete,
      weights: readLaneWeights(weightsFilePath(input.env)),
      snapshot: { readAt: currentIso(), items: snapshotItems(input) },
      records: read.record === null ? [] : [read.record],
      allocationBlocked: read.blocked,
      ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    };
  } catch (error) {
    report.priorities = failedPart(error, input.enforce === true);
    return null;
  }
}

/**
 * Rank every prepared repository in one transaction: open the week, record
 * the host's lane transitions once from the union of their ready lanes, then
 * rank each. A failure is reported on the repositories' own parts, never
 * thrown, and never touches the plan.
 */
export function rankPriorities(
  prepared: readonly PreparedPriorities[],
  nowMs: number,
  complete: boolean,
  enforce = false,
): void {
  const first = prepared[0];
  if (first === undefined) return;
  try {
    const db = stateDb(first.stateRoot);
    inTransaction(db, () => {
      const week = openWeek(db, nowMs);
      pruneCharges(db, nowMs);
      pruneEpochs(db, week.week);
      const whole = complete && prepared.every(observedWhole);
      const ready = new Set<WeightedLane>();
      for (const p of prepared) for (const l of readyLanes(p)) ready.add(l);
      const epochs = recordEpochs(
        db,
        week,
        ready,
        hashOf(prepared.map((p) => [p.slug, p.snapshot.items])),
        nowMs,
        whole,
      );
      for (const p of prepared)
        try {
          p.report.priorities = rankOne(
            db,
            p,
            { epochs, week },
            nowMs,
            enforce,
          );
        } catch (error) {
          p.report.priorities = failedPart(error, enforce);
        }
    });
  } catch (error) {
    for (const p of prepared) p.report.priorities = failedPart(error, enforce);
  }
}

/** Whether the repository's record and tracker reads both answered: a failed read is no evidence a lane has no ready work. */
function observedWhole(p: PreparedPriorities): boolean {
  return (
    p.read.complete &&
    p.trackerComplete &&
    !p.report.unplaced.some(
      (u) =>
        u.readFailed === true ||
        u.failure !== undefined ||
        u.scopeFailure !== undefined,
    )
  );
}

/** Rank one prepared repository against the host's week and epochs, and keep its ranking. */
function rankOne(
  db: Database,
  p: PreparedPriorities,
  host: Pick<RankerInput, "epochs" | "week">,
  nowMs: number,
  enforce: boolean,
): PrioritiesReport {
  const rankerInput: RankerInput = {
    asOf: p.snapshot.readAt,
    snapshot: p.snapshot,
    records: p.records,
    allocationBlocked: p.allocationBlocked,
    weights: p.weights,
    // Enforced, the ranking places every pickup the tick read, so none waits behind the report's depth.
    capacity: {
      starts: enforce
        ? Math.max(SHORTLIST_DEPTH, p.snapshot.items.length)
        : SHORTLIST_DEPTH,
    },
    ...host,
  };
  const output = rank(rankerInput);
  const classes = classesOf(p.snapshot.items, p.records, p.allocationBlocked);
  saveRanking(db, p.slug, rankerInput, output, classes, nowMs);
  const enforced = enforce
    ? enforcePickupOrder(p.report.actions, output, classes)
    : null;
  if (enforced !== null) p.report.actions = enforced.actions;
  return {
    ...(enforced === null ? {} : { enforced: enforced.order }),
    record: {
      source: p.read.source,
      blocked: p.read.blocked,
      lastValid: p.read.lastValid,
      revision: p.read.record?.revision ?? null,
    },
    weights: { source: p.weights.source, problems: p.weights.problems },
    ranking: output,
  };
}

function failedPart(error: unknown, enforce = false): { failed: string } {
  return {
    failed: enforce
      ? `the priorities ranking failed, so pickups start in dispatch's own order this tick: ${failureText(error)}`
      : `the report-only priorities ranking failed: ${failureText(error)}`,
  };
}

/** The tick's pickups as snapshot items, each excluded where the plan left it unplaced. */
function snapshotItems(
  input: Pick<PrioritiesTickInput, "pickups" | "unplaced" | "scope">,
): SnapshotItem[] {
  const reasons = new Map(input.unplaced.map((u) => [u.target, u.reason]));
  const starts: SnapshotItem[] = [];
  const ancestors: SnapshotItem[] = [];
  for (const p of input.pickups) {
    if (p.queueIssue === undefined) {
      starts.push(bareItem(p, input.scope, reasons.get(p.key) ?? null));
      continue;
    }
    const item = snapshotItem(p.queueIssue, {
      scope: input.scope,
      excluded: reasons.get(p.key) ?? null,
    });
    // The served walk names the epic it reached an item through (the served
    // person's, or the factory's); that is ancestry enough for membership
    // where the read carried no parent.
    const ancestor = p.ancestorEpic ?? p.factoryAncestor;
    const withAncestor =
      item.gaps.includes("parent") && ancestor !== undefined
        ? {
            ...item,
            parent: ancestor,
            gaps: item.gaps.filter((g) => g !== "parent"),
          }
        : item;
    starts.push({
      ...withAncestor,
      state: "ready",
      // Dispatch's own selection admits only unblocked work: a pickup's unread relations are no gap.
      gaps: withAncestor.gaps.filter((g) => g !== "blockers"),
    });
    const node = ancestorItem(p.queueIssue, input.scope);
    if (node !== null) ancestors.push(node);
  }
  const keys = new Set(starts.map((i) => i.key));
  return [
    ...starts,
    ...ancestors.filter((n) => !keys.has(n.key) && keys.add(n.key)),
  ];
}

/** An item the read carried only in its listing form: every facet it lacks is a gap. */
function bareItem(
  p: WantedItem,
  scope: string,
  excluded: string | null,
): SnapshotItem {
  return {
    scope,
    key: p.key,
    title: p.title,
    priority: null,
    type: null,
    state: "ready",
    isEpic: false,
    parent: p.ancestorEpic ?? p.factoryAncestor ?? null,
    children: [],
    blockers: [],
    assigned: p.pooled !== true,
    labels: [],
    dueDate: null,
    project: null,
    cycle: null,
    excluded,
    gaps: [
      "priority",
      "type",
      ...(p.ancestorEpic === undefined && p.factoryAncestor === undefined
        ? (["parent"] as const)
        : []),
      "dueDate",
      "project",
      "cycle",
    ],
  };
}

function classesOf(
  items: SnapshotItem[],
  records: RankerInput["records"],
  blocked: string | null,
): Record<string, ItemClass> {
  const out: Record<string, ItemClass> = {};
  for (const c of classify(items, records, blocked))
    out[c.item.key] = {
      lane: c.lane,
      objective: c.placement?.objective ?? null,
      owners: c.owners as Record<string, string>,
    };
  return out;
}

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
 * and puts the shortlist on its report. Dispatch's selection does not read
 * any of it.
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
import { snapshotItem } from "./priorities-snapshot.ts";
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
import { readRepositoryRecord, type RecordRead } from "./priorities-read.ts";
import { inTransaction, stateDb } from "./state.ts";
import { failureText } from "./text.ts";
import type { RepoReport, Unplaced, WantedItem } from "./types.ts";

/** How many prospective starts the report-only shortlist proposes. */
const SHORTLIST_DEPTH = 10;

/** The priorities part of a repository's report. */
export interface PrioritiesReport {
  record: Omit<RecordRead, "record"> & { revision: number | null };
  weights: { source: string; problems: string[] };
  ranking: RankerOutput;
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
  nowMs: number;
  env?: Record<string, string | undefined>;
  stateRoot?: string;
}

/** One repository's inputs to the tick's ranking, read after its plan. */
export interface PreparedPriorities {
  report: RepoReport;
  slug: string;
  read: RecordRead;
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
    );
    return {
      report,
      slug: input.slug,
      read,
      weights: readLaneWeights(weightsFilePath(input.env)),
      snapshot: { readAt: currentIso(), items: snapshotItems(input) },
      records: read.record === null ? [] : [read.record],
      allocationBlocked: read.blocked,
      ...(input.stateRoot === undefined ? {} : { stateRoot: input.stateRoot }),
    };
  } catch (error) {
    report.priorities = failedPart(error);
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
): void {
  const first = prepared[0];
  if (first === undefined) return;
  try {
    const db = stateDb(first.stateRoot);
    inTransaction(db, () => {
      const week = openWeek(db, nowMs);
      pruneCharges(db, nowMs);
      pruneEpochs(db, week.week);
      const ready = new Set<WeightedLane>();
      for (const p of prepared) for (const l of readyLanes(p)) ready.add(l);
      const epochs = recordEpochs(
        db,
        week,
        ready,
        hashOf(prepared.map((p) => [p.slug, p.snapshot.items])),
        nowMs,
      );
      for (const p of prepared)
        try {
          p.report.priorities = rankOne(db, p, { epochs, week }, nowMs);
        } catch (error) {
          p.report.priorities = failedPart(error);
        }
    });
  } catch (error) {
    for (const p of prepared) p.report.priorities = failedPart(error);
  }
}

/** Rank one prepared repository against the host's week and epochs, and keep its ranking. */
function rankOne(
  db: Database,
  p: PreparedPriorities,
  host: Pick<RankerInput, "epochs" | "week">,
  nowMs: number,
): PrioritiesReport {
  const rankerInput: RankerInput = {
    asOf: p.snapshot.readAt,
    snapshot: p.snapshot,
    records: p.records,
    allocationBlocked: p.allocationBlocked,
    weights: p.weights,
    capacity: { starts: SHORTLIST_DEPTH },
    ...host,
  };
  const output = rank(rankerInput);
  saveRanking(
    db,
    p.slug,
    rankerInput,
    output,
    classesOf(p.snapshot.items, p.records, p.allocationBlocked),
    nowMs,
  );
  return {
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

function failedPart(error: unknown): { failed: string } {
  return {
    failed: `the report-only priorities ranking failed: ${failureText(error)}`,
  };
}

/** The tick's pickups as snapshot items, each excluded where the plan left it unplaced. */
function snapshotItems(
  input: Pick<PrioritiesTickInput, "pickups" | "unplaced" | "scope">,
): SnapshotItem[] {
  const reasons = new Map(input.unplaced.map((u) => [u.target, u.reason]));
  return input.pickups.flatMap((p) => {
    if (p.queueIssue === undefined)
      return [bareItem(p, input.scope, reasons.get(p.key) ?? null)];
    const item = snapshotItem(p.queueIssue, {
      scope: input.scope,
      excluded: reasons.get(p.key) ?? null,
    });
    // The served walk names the epic it reached an item through; that is
    // ancestry enough for membership where the read carried no parent.
    const withAncestor =
      item.gaps.includes("parent") && p.ancestorEpic !== undefined
        ? {
            ...item,
            parent: p.ancestorEpic,
            gaps: item.gaps.filter((g) => g !== "parent"),
          }
        : item;
    return [{ ...withAncestor, state: "ready" }];
  });
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
    parent: p.ancestorEpic ?? null,
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
      ...(p.ancestorEpic === undefined ? (["parent"] as const) : []),
      "blockers",
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

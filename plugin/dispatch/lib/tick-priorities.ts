/**
 * The tick's report-only ranking of declared priorities
 * ([design](../../../design/priorities-and-overview.md#computed-ranking-proposes-a-shortlist)).
 * After the plan, on the host that owns the repository, it builds the
 * tracker snapshot from the pickups the tick already read (no further
 * tracker call), reads the repository record and the host's weights file
 * again, opens the week (writing the completed week's row once), records the
 * lanes' ready transitions, ranks, keeps the newest ranking for the claim
 * path's charge and puts the shortlist on the report. Dispatch's selection
 * does not read any of it.
 */
import { currentIso } from "../../shared/time.ts";
import { hashOf } from "../../shared/priorities/hash.ts";
import {
  rank,
  type RankerInput,
  type RankerOutput,
  readyLanes,
} from "../../shared/priorities/ranker.ts";
import {
  snapshotItem,
  type SnapshotItem,
} from "../../shared/priorities/snapshot.ts";
import {
  readLaneWeights,
  weightsFilePath,
} from "../../shared/priorities/weights.ts";
import { classify } from "../../shared/priorities/classify.ts";
import {
  type ItemClass,
  openWeek,
  pruneCharges,
  recordEpochs,
  saveRanking,
} from "./allocation-store.ts";
import { readRepositoryRecord, type RecordRead } from "./priorities-read.ts";
import { inTransaction, stateDb } from "./state.ts";
import type { RepoReport, Unplaced, WantedItem } from "./types.ts";

/** How many prospective starts the report-only shortlist proposes. */
export const SHORTLIST_DEPTH = 10;

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

/** Rank one repository's pickups; the report part, or why it could not be made. */
export function rankRepository(input: PrioritiesTickInput): PrioritiesReport {
  const read = readRepositoryRecord(
    input.path,
    input.defaultBranch,
    input.nowMs,
  );
  const weights = readLaneWeights(weightsFilePath(input.env));
  const items = snapshotItems(input);
  const snapshot = { readAt: currentIso(), items };
  const records = read.record === null ? [] : [read.record];
  const allocationBlocked = read.blocked;
  const db = stateDb(input.stateRoot);
  const ranked = inTransaction(db, () => {
    const week = openWeek(db, input.nowMs);
    pruneCharges(db, input.nowMs);
    const ready = readyLanes({ snapshot, records, allocationBlocked });
    const epochs = recordEpochs(
      db,
      week,
      ready,
      hashOf(snapshot.items),
      input.nowMs,
    );
    const rankerInput: RankerInput = {
      asOf: snapshot.readAt,
      snapshot,
      records,
      allocationBlocked,
      weights,
      capacity: { starts: SHORTLIST_DEPTH },
      epochs,
      week,
    };
    const output = rank(rankerInput);
    saveRanking(
      db,
      input.slug,
      rankerInput,
      output,
      classesOf(items, records, allocationBlocked),
      input.nowMs,
    );
    return output;
  });
  return {
    record: {
      source: read.source,
      blocked: read.blocked,
      lastValid: read.lastValid,
      revision: read.record?.revision ?? null,
    },
    weights: { source: weights.source, problems: weights.problems },
    ranking: ranked,
  };
}

/** The tick's pickups as snapshot items, each excluded where the plan left it unplaced. */
export function snapshotItems(
  input: Pick<PrioritiesTickInput, "pickups" | "unplaced" | "scope">,
): SnapshotItem[] {
  const reasons = new Map(input.unplaced.map((u) => [u.target, u.reason]));
  return input.pickups.flatMap((p) => {
    if (p.queueIssue === undefined) return [];
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

/** Put the ranking on `report`; a failure is reported on its own part, never thrown, and never touches the plan. */
export function reportPriorities(
  report: RepoReport,
  input: PrioritiesTickInput,
): void {
  try {
    report.priorities = rankRepository(input);
  } catch (error) {
    report.priorities = {
      failed: `the report-only priorities ranking failed: ${(error as Error).message}`,
    };
  }
}

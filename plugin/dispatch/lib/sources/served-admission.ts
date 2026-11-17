/** Shared width reservations for factory and served candidates, through every ancestor. */
import type { QueueItem } from "../queue-rank.ts";
import { rankQueue } from "../queue-rank.ts";
import type { ServedOptions, ServedReading } from "./served.ts";
import {
  serializeEpics,
  summarizeEpics,
  type Serial,
  type Admission,
  type EpicWalk,
  type PassedChild,
} from "./served-epics.ts";

export interface Candidate extends QueueItem {
  admissions?: Admission[];
  identity: string;
  factory?: boolean;
  by: string;
  ancestor?: string | undefined;
  blockingFor?: string | undefined;
  serial?: Serial | undefined;
}

/** An active descendant occupies its branch's slot even before its epic's tracker state moves. */
function inheritWorking(shared: {
  walks: EpicWalk[];
  serials: Map<string, Serial>;
}): void {
  const working = new Set(
    shared.walks.filter((w) => w.working).map((w) => w.key),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const walk of shared.walks) {
      if (
        !working.has(walk.key) &&
        walk.children.some((key) => working.has(key))
      ) {
        working.add(walk.key);
        changed = true;
      }
    }
  }
  for (const key of working) {
    const parent = shared.serials.get(key);
    if (parent !== undefined && !parent.busy.includes(key))
      parent.busy.push(key);
  }
}

export function finishAdmission(
  candidates: Candidate[],
  shared: { walks: EpicWalk[]; serials: Map<string, Serial> },
  out: ServedReading,
  options: ServedOptions,
): void {
  inheritWorking(shared);
  for (const c of candidates) {
    const serial = shared.serials.get(c.issue.identifier);
    if (c.serial === undefined && serial !== undefined) c.serial = serial;
  }
  const passed = new Map<string, PassedChild>();
  const ranked = serializeEpics(
    rankQueue(candidates),
    out.unplaced,
    options.epicWidth,
    options.passOver,
    passed,
  );
  summarizeEpics(
    shared.walks,
    new Set(
      ranked.map((c) => c.issue.identifier).filter((key) => !passed.has(key)),
    ),
    out.unplaced,
    passed,
  );
  out.wanted = ranked.map((c) => ({
    key: c.issue.identifier,
    title: c.issue.title,
    url: c.issue.url,
    state: c.issue.state.name,
    assignee: c.identity,
    assignedBy: c.by,
    ...(c.factory ? {} : { servedPerson: c.identity }),
    queueIssue: c.issue,
    ...(c.issue.updatedAt === undefined
      ? {}
      : { updatedAt: c.issue.updatedAt }),
    queueRank: {
      unblocks: c.unblocks,
      ...(c.epicOrder === undefined ? {} : { epicOrder: c.epicOrder }),
    },
    ...(c.ancestor === undefined
      ? {}
      : c.factory
        ? { factoryAncestor: c.ancestor }
        : { ancestorEpic: c.ancestor }),
    ...(c.blockingFor === undefined
      ? {}
      : { blockingFor: c.blockingFor, batchAllowed: false }),
  }));
}

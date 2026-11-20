/** Rank eligible factory and served candidates and summarize their epics. */
import type { QueueItem } from "../queue-rank.ts";
import type { QueueIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { rankQueue } from "../queue-rank.ts";
import type { ServedOptions, ServedReading } from "./served.ts";
import {
  summarizeEpics,
  type EpicWalk,
  type PassedChild,
} from "./served-epics.ts";

export interface Candidate extends QueueItem {
  identity: string;
  factory?: boolean;
  by: string;
  ancestor?: string | undefined;
  /** The relations and parent the queue read carried for the issue; absent where it carried no parent. */
  queueRead?: Pick<QueueIssue, "relations" | "parent">;
  blockingFor?: string | undefined;
}

export function finishAdmission(
  candidates: Candidate[],
  shared: { walks: EpicWalk[] },
  out: ServedReading,
  options: ServedOptions,
): void {
  const ranked = rankQueue(candidates);
  const passed = new Map<string, PassedChild>();
  const parentByChild = new Map(
    shared.walks.flatMap(({ key, children }) =>
      children.map((child) => [child, key] as const),
    ),
  );
  for (const candidate of ranked) {
    const key = candidate.issue.identifier;
    const epic = parentByChild.get(key);
    const why = options.passOver?.(candidate.issue);
    if (epic !== undefined && why != null) passed.set(key, { epic, why });
  }
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
    queueIssue:
      c.queueRead === undefined ? c.issue : { ...c.issue, ...c.queueRead },
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

/**
 * What is coming, as a pure function of the line: ordered by what will happen to
 * each target, not by where it came from.
 */
import type {
  LineQueued,
  LineSnapshot,
  QueueGroup,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { queuedFollowup } from "./followup-view.ts";
import { ago } from "./format.ts";
import { ROLES, type Role } from "./status.ts";
import { type Clock, nextFreeAccount } from "./view.ts";

// ---------- what is coming ----------

export interface QueueItemView {
  rowKey: string;
  target: string;
  url: string | null;
  repo: string;
  source: string;
  followup: string | null;
  title: string | null;
  why: string | null;
  wait: string | null;
  role: Role;
}

export interface QueueGroupView {
  group: QueueGroup;
  title: string;
  note: string | null;
  /** Whether the note stays visible in the compact view. */
  keepNote: boolean;
  items: QueueItemView[];
}

function queueItem(q: LineQueued, nowMs: number): QueueItemView {
  return {
    rowKey: `${q.repo} ${q.target} ${q.source}`,
    target: q.target,
    url: q.url,
    repo: q.repo,
    source: q.source,
    followup: q.source === "merged" ? queuedFollowup(q.group) : null,
    title: q.title,
    why:
      q.hold === null
        ? q.why
        : `held: serialized behind #${q.hold.leader} in ${q.hold.area}`,
    wait:
      q.hold === null ? null : `waited ${ago(Date.parse(q.hold.since), nowMs)}`,
    role: q.stale ? ROLES.stale : ROLES.held,
  };
}

function longestWaitFirst(a: LineQueued, b: LineQueued): number {
  const since = (q: LineQueued) =>
    q.hold === null ? Number.POSITIVE_INFINITY : Date.parse(q.hold.since);
  return since(a) - since(b);
}

/** The queue, ordered by what will happen to each target. */
export function queueGroups(
  line: LineSnapshot,
  clockNow: Clock,
): QueueGroupView[] {
  const { nowMs } = clockNow;
  const inGroup = (group: QueueGroup) =>
    line.queue.filter((q) => q.group === group);
  const groups: QueueGroupView[] = [];
  const add = (
    group: QueueGroup,
    title: string,
    list: LineQueued[],
    note: string | null,
    keepNote = false,
  ) => {
    if (list.length > 0)
      groups.push({
        group,
        title,
        note,
        keepNote,
        items: list.map((q) => queueItem(q, nowMs)),
      });
  };
  const next = nextFreeAccount(line, clockNow);
  add(
    "starts",
    "Starts when a tick finds a free slot",
    inGroup("starts"),
    next === null
      ? "No account has a free slot and no wall; these wait."
      : `Next free account: ${next}.`,
  );
  add(
    "held",
    "Held behind a serialized leader",
    inGroup("held").sort(longestWaitFirst),
    null,
  );
  const reported = inGroup("reported");
  add(
    "reported",
    "Reported, not started",
    reported,
    reported.find((q) => q.launch !== null)?.launch?.detail ?? null,
    true,
  );
  add("never", "Will not start", inGroup("never"), null);
  return groups;
}

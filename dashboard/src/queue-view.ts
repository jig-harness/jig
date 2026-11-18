/**
 * What is coming, as a pure function of the line: ordered by what will happen to
 * each target, not by where it came from.
 */
import type {
  LineLinks,
  LineQueued,
  LineSnapshot,
  QueueGroup,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { queuedFollowup } from "./followup-view.ts";
import { ago } from "./format.ts";
import { ROLES, type Role } from "./status.ts";
import { type Clock, type EvidenceRow, nextFreeAccount } from "./view.ts";

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
  /** The record behind it, which its card folds. */
  evidence: EvidenceRow[];
  /** The work the line links it to; absent when the line does not say. */
  links?: LineLinks;
}

function queueEvidence(q: LineQueued): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    { k: "source", v: q.source },
    { k: "reason", v: q.why },
  ];
  if (q.assignedBy !== null) rows.push({ k: "assigned by", v: q.assignedBy });
  if (q.launch !== null)
    rows.push({
      k: "last launch",
      v: `${q.launch.outcome}: ${q.launch.detail}`,
    });
  if (q.overlap !== undefined)
    rows.push(
      { k: q.overlap.relation, v: `${q.overlap.count}` },
      ...q.overlap.on.map((r) => ({
        k: r.kind,
        v: `${r.ref} (${r.state})${r.url === null ? "" : ` ${r.url}`}`,
      })),
    );
  if (q.footprint !== undefined) rows.push({ k: "footprint", v: q.footprint });
  return rows;
}

/** Why a queued target waits: a serialized hold, else its overlap, else the record's own reason; a pickup's unknown footprint beside it. A launch that was refused or only reported keeps its own reason first, with the overlap beside it as what would hold the start. */
function whyOf(q: LineQueued): string {
  const decided =
    q.launch?.outcome === "refused" || q.launch?.outcome === "reported";
  const why =
    q.hold !== null
      ? `held: serialized behind #${q.hold.leader} in ${q.hold.area}`
      : decided
        ? q.overlap === undefined
          ? q.why
          : `${q.why} · ${q.overlap.text}`
        : (q.overlap?.text ?? q.why);
  return q.footprint === undefined ? why : `${why} · ${q.footprint}`;
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
    why: whyOf(q),
    wait:
      q.hold === null ? null : `waited ${ago(Date.parse(q.hold.since), nowMs)}`,
    role: q.stale ? ROLES.stale : ROLES.held,
    evidence: queueEvidence(q),
    ...(q.links === undefined ? {} : { links: q.links }),
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
      ? "No account can take a new launch; these wait."
      : `Available account: ${next}. Launch weights determine the next choice.`,
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

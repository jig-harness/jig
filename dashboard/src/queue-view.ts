/**
 * What is coming, as a pure function of the line: ordered by what will happen to
 * each target, not by where it came from. Every grouping is cut from that one
 * order, so going back to the default gives the dispatcher's order again.
 */
import type {
  LineLinks,
  LineQueued,
  LineSnapshot,
  QueueGroup,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { QUEUE_SOURCES, type QueueGrouping, type QueueKind } from "./facets.ts";
import { queuedFollowup } from "./followup-view.ts";
import { ago } from "./format.ts";
import { ROLES, type Role, sourceMeaning } from "./status.ts";
import { type Clock, type EvidenceRow, nextFreeAccount } from "./view.ts";

// ---------- what is coming ----------

export interface QueueItemView {
  rowKey: string;
  target: string;
  url: string | null;
  repo: string;
  source: string;
  kind: QueueKind;
  group: QueueGroup;
  /** What will happen to it, as its group's heading says. */
  happens: string;
  /** Why it will not start, as the group's heading counts it; `null` for one that may. */
  refusal: string | null;
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

/** Why a queued target waits: a serialized hold, else its overlap, else the record's own reason; a pickup's unknown footprint beside it. A launch that was refused or only reported leads with its own detail, with the overlap beside it as what would hold the start. */
function whyOf(q: LineQueued): string {
  const launch = q.launch;
  const decided =
    launch !== null &&
    (launch.outcome === "refused" || launch.outcome === "reported");
  const why =
    q.hold !== null
      ? `held: serialized behind #${q.hold.leader} in ${q.hold.area}`
      : decided
        ? q.overlap === undefined
          ? launch.detail
          : `${launch.detail} · ${q.overlap.text}`
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

const GROUP_TITLE: Record<QueueGroup, string> = {
  starts: "Starts next",
  held: "Held behind a serialized leader",
  reported: "Reported, not started",
  never: "Will not start",
};

/** The longest reason a heading repeats whole. */
const REASON_CHARS = 60;

/** Why a target will not start, as a kind of refusal: who was refused stays on the card. */
export function refusalReason(q: LineQueued): string {
  const said = q.launch?.outcome === "refused" ? q.launch.detail : q.why;
  if (said.includes("who cannot write"))
    return said.includes("moved to ")
      ? "moved by someone who cannot write"
      : "assigned by someone who cannot write";
  const clause = said.split(/[:;]/, 1)[0]?.trim() ?? "";
  if (clause === "") return "no reason recorded";
  return clause.length > REASON_CHARS
    ? `${clause.slice(0, REASON_CHARS - 1)}…`
    : clause;
}

/** How many reasons a heading names before it gathers the rest. */
const NAMED_REASONS = 2;

/** Reasons as a heading says them: the commonest first, with their counts. */
export function reasonCounts(reasons: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons)
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const named = ranked
    .slice(0, NAMED_REASONS)
    .map(([reason, count]) => `${count} ${reason}`);
  const others = ranked
    .slice(NAMED_REASONS)
    .reduce((sum, [, count]) => sum + count, 0);
  if (others > 0)
    named.push(
      others === 1 ? "1 for another reason" : `${others} for other reasons`,
    );
  return named.join(", ");
}

function queueItem(q: LineQueued, nowMs: number): QueueItemView {
  return {
    rowKey: `${q.repo} ${q.target} ${q.source}`,
    target: q.target,
    url: q.url,
    repo: q.repo,
    source: q.source,
    kind: q.pr === null ? "item" : "pull request",
    group: q.group,
    happens: GROUP_TITLE[q.group],
    refusal: q.group === "never" ? refusalReason(q) : null,
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
    list: LineQueued[],
    note: string | null,
    keepNote = false,
  ) => {
    if (list.length > 0)
      groups.push({
        group,
        title: GROUP_TITLE[group],
        note,
        keepNote,
        items: list.map((q) => queueItem(q, nowMs)),
      });
  };
  const next = nextFreeAccount(line, clockNow);
  add(
    "starts",
    inGroup("starts"),
    next === null
      ? "No account can take a new launch; these wait."
      : `When a tick finds a free slot. Available account: ${next}. Launch weights determine the next choice.`,
  );
  add("held", inGroup("held").sort(longestWaitFirst), null);
  const reported = inGroup("reported");
  add(
    "reported",
    reported,
    reported.find((q) => q.launch !== null)?.launch?.detail ?? null,
    true,
  );
  add("never", inGroup("never"), null);
  return groups;
}

// ---------- the sections a grouping cuts it into ----------

export interface QueueSectionView {
  key: string;
  by: QueueGrouping;
  /** The group, repository or source it holds. */
  value: string;
  /** Its heading; `null` for the one flat list of no grouping. */
  title: string | null;
  note: string | null;
  keepNote: boolean;
  /** Whether its heading never folds. */
  fixed: boolean;
  startsFolded: boolean;
  /** Why its targets will not start, in counts, where that is what it holds. */
  reasons: string | null;
  items: QueueItemView[];
}

/** "Will not start" folds above this many cards, which would bury the rest. */
const NEVER_OPEN_UP_TO = 5;

function groupSection(g: QueueGroupView): QueueSectionView {
  const never = g.group === "never";
  return {
    key: `group ${g.group}`,
    by: "group",
    value: g.group,
    title: g.title,
    note: g.note,
    keepNote: g.keepNote,
    fixed: g.group === "starts",
    startsFolded: never && g.items.length > NEVER_OPEN_UP_TO,
    reasons: never
      ? reasonCounts(g.items.flatMap((i) => i.refusal ?? []))
      : null,
    items: g.items,
  };
}

/** The items by `keyOf`, each list in the order it was given. */
function bucketed(
  items: readonly QueueItemView[],
  keyOf: (item: QueueItemView) => string,
): Map<string, QueueItemView[]> {
  const buckets = new Map<string, QueueItemView[]>();
  for (const item of items) {
    const value = keyOf(item);
    const bucket = buckets.get(value);
    if (bucket === undefined) buckets.set(value, [item]);
    else bucket.push(item);
  }
  return buckets;
}

function plainSection(
  by: QueueGrouping,
  value: string,
  items: QueueItemView[],
  note: string | null,
): QueueSectionView {
  return {
    key: `${by} ${value}`,
    by,
    value,
    title: value,
    note,
    keepNote: false,
    fixed: false,
    startsFolded: false,
    reasons: null,
    items,
  };
}

/** The sections a grouping shows, each keeping the dispatcher's order within it. */
export function queueSections(
  groups: readonly QueueGroupView[],
  grouping: QueueGrouping,
): QueueSectionView[] {
  if (grouping === "group") return groups.map(groupSection);
  const items = groups.flatMap((g) => g.items);
  if (items.length === 0) return [];
  if (grouping === "none")
    return [{ ...plainSection("none", "all", items, null), title: null }];
  if (grouping === "repo")
    return [...bucketed(items, (item) => item.repo)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, list]) => plainSection("repo", repo, list, null));
  const rank = (source: string) => {
    const at = (QUEUE_SOURCES as readonly string[]).indexOf(source);
    return at === -1 ? QUEUE_SOURCES.length : at;
  };
  return [...bucketed(items, (item) => item.source)]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([source, list]) =>
      plainSection("source", source, list, sourceMeaning(source)),
    );
}

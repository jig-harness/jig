/**
 * The Merge view, as data: Ready to merge's three lanes from the line, each
 * card with the command a person copies, and the merge flash that every other
 * view shows while merge now holds a pull request.
 */
import type {
  LineReady,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  ACT_WORDS,
  type Lane,
  LANES,
} from "../../plugin/skills/drive-pr/scripts/lib/merge-ready.ts";
import { ago } from "./format.ts";

const LANE_TITLE: Record<Lane, string> = {
  "merge-now": "Merge now",
  "approve-first": "Approve first",
  "update-next": "Update next",
};

const LANE_NOTE: Record<Lane, string> = {
  "merge-now":
    "Converged, its review witnessed at the head the drive verified, and mergeable. The command merges that head only.",
  "approve-first":
    "Everything else the board reads holds; an approval is owed. The forge may ask for more once it is given.",
  "update-next":
    "The repository requires an up-to-date branch. Updating moves the head, which costs a re-drive.",
};

export interface MergeCardView {
  rowKey: string;
  repo: string;
  target: string;
  url: string;
  title: string;
  says: string;
  /** The person's act, in the board's own words; `null` when it settles by waiting. */
  act: string | null;
  /** What `c` and the card's Copy take: the pinned merge command, else the pull request's `jig ask` line. */
  command: string;
  /** Whether `command` is the pinned merge command. */
  merges: boolean;
  withheld: string | null;
  failing: string[];
  conditions: LineReady["conditions"];
  unblocks: number[];
  age: string;
}

export interface MergeLaneView {
  lane: Lane;
  title: string;
  note: string;
  cards: MergeCardView[];
}

/** The `jig ask` line for a pull request's drive (design/addresses.md). */
function askLine(repo: string, pr: number): string {
  return `jig ask drive@${repo}#${pr}`;
}

function cardOf(r: LineReady, nowMs: number): MergeCardView {
  return {
    rowKey: `${r.repo} ${r.pr} ${r.head}`,
    repo: r.repo,
    target: `PR #${r.pr}`,
    url: r.url,
    title: r.title,
    says: r.says,
    act: r.act === null ? null : ACT_WORDS[r.act],
    command: r.command ?? askLine(r.repo, r.pr),
    merges: r.command !== null,
    withheld: r.withheld,
    failing: r.failing,
    conditions: r.conditions,
    unblocks: r.unblocks,
    age: ago(Date.parse(r.since), nowMs),
  };
}

/** The pull requests in Ready to merge, by lane in the order of the work they ask; a lane with none is left out. */
export function mergeLanes(
  line: LineSnapshot | null,
  nowMs: number,
): MergeLaneView[] {
  const ready = line?.ready ?? [];
  return LANES.flatMap((lane) => {
    const cards = ready
      .filter((r) => r.lane === lane)
      .map((r) => cardOf(r, nowMs));
    return cards.length === 0
      ? []
      : [{ lane, title: LANE_TITLE[lane], note: LANE_NOTE[lane], cards }];
  });
}

/** How many pull requests Ready to merge holds, which the Merge tab carries. */
export function mergeCount(line: LineSnapshot | null): number {
  return (line?.ready ?? []).filter((r) => r.lane !== null).length;
}

/** The pull requests in merge now. */
function mergeNow(line: LineSnapshot | null): LineReady[] {
  return (line?.ready ?? []).filter((r) => r.lane === "merge-now");
}

/** How many pull requests merge now holds, which decides the view a page opens on. */
export function mergeNowCount(line: LineSnapshot | null): number {
  return mergeNow(line).length;
}

/** Each pull request in merge now at its verified head: a new head is a new key, so a dismissed flash comes back. */
export function mergeNowKeys(line: LineSnapshot | null): string[] {
  return mergeNow(line).map((r) => `${r.repo}#${r.pr}@${r.head}`);
}

export interface FlashView {
  text: string;
  /** The keys a dismissal hides it for. */
  keys: string[];
}

/** The merge flash, or `null` while merge now is empty or every pull request in it was dismissed at its head. */
export function flashOf(
  line: LineSnapshot | null,
  dismissed: ReadonlySet<string>,
): FlashView | null {
  const now = mergeNow(line);
  if (now.length === 0) return null;
  const keys = mergeNowKeys(line);
  if (keys.every((k) => dismissed.has(k))) return null;
  const prs = now.map((r) => `#${r.pr}`).join(", ");
  const text =
    now.length === 1
      ? `1 pull request is safe to merge: ${prs}`
      : `${now.length} pull requests are safe to merge: ${prs}`;
  return { text, keys };
}

/** Why each repository's board read placed nothing, for the foot of the Merge view. */
export function boardNotes(line: LineSnapshot | null): string[] {
  return (line?.repos ?? []).flatMap((r) => {
    const notes: string[] = [];
    const slug = r.slug ?? r.path;
    if (r.boardUnread !== undefined && r.boardUnread !== null)
      notes.push(`${slug}: not read in full, ${r.boardUnread}`);
    if (r.readyOmitted !== undefined && r.readyOmitted > 0)
      notes.push(`${slug}: ${r.readyOmitted} more not shown`);
    return notes;
  });
}

/**
 * The notices that wait for room in the notices comment, counted in one
 * summary entry of the comment instead of failing.
 *
 * One comment holds at most `MAX_COMMENT` characters, and an entry whose
 * cause still stands is never dropped from an unread one, so a repository
 * can have more standing causes than its comment holds. Those wait (they
 * are not sent, so they get no suppression record and stay due every tick)
 * and are told in full as soon as there is room: once a person reads the
 * workspace, or as the comment's other entries settle. Meanwhile the
 * comment carries a summary entry that says how many wait, of which
 * kinds, which ones, and where to read every one. `SUMMARY_ROOM` characters
 * of every comment the dispatcher writes are kept for it.
 *
 * The summary is an ordinary entry with a key line of its own, keyed by a
 * digest of the keys it counts: a summary of other causes is a new entry,
 * which replaces the previous one, and the same causes keep the same entry.
 */
import { createHash } from "node:crypto";
import type { NoticeCause } from "../types.ts";
import { entryKeys, noticeComment } from "./notice-comment.ts";
import { MAX_COMMENT } from "./port.ts";

/** The characters every comment the dispatcher writes keeps for the summary entry, its separator included. */
export const SUMMARY_ROOM = 1500;

const TAG = "[jig dispatch: ";

/** The longest line the summary gives one waiting cause. */
const LINE = 120;

/**
 * Why a cause waits for room and no summary counts it: the unread comment,
 * less the entries whose causes are settled, leaves too little. It is not a
 * failed delivery.
 */
export const NO_ROOM =
  "the comment is full: its unread entries still stand, or a person added to it; it waits, and goes once a person reads the notices workspace, its entries settle or personal additions are shortened";

/** Why a cause waits for room while the comment's summary entry counts it. */
export const COUNTED_IN_SUMMARY =
  "it waits for room in the notices comment and is counted in the notices workspace's summary entry; it goes in full once a person reads the workspace or its entries settle";

/** Whether a channel's detail says the cause waits for room in the comment, which is not a failed delivery. */
export function heldForRoom(detail: string): boolean {
  return detail === NO_ROOM || detail === COUNTED_IN_SUMMARY;
}

/** The start of the key of every summary entry of `slug`'s notices. */
function summaryPrefix(slug: string): string {
  return `notices waiting ${slug} `;
}

/** The keys of the summary entries a comment holds. */
export function summaryKeys(comment: string, slug: string): string[] {
  const prefix = summaryPrefix(slug);
  return entryKeys(comment).filter((k) => k.startsWith(prefix));
}

/** Text on one line, at most `max` characters, never opening a key line. */
function compact(text: string, max: number): string {
  const line = text
    .replaceAll(TAG, "[jig dispatch - ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** How many causes of each kind wait, the most frequent first. */
function kinds(held: readonly NoticeCause[]): string {
  const count = new Map<string, number>();
  for (const c of held) count.set(c.cause, (count.get(c.cause) ?? 0) + 1);
  return [...count]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(", ");
}

/**
 * The summary entry of the causes held back for room: at most
 * `SUMMARY_ROOM` characters with the separator before it. It lists as many
 * of them as fit, then how many more there are.
 */
export function overflowSummary(
  slug: string,
  held: readonly NoticeCause[],
): { key: string; text: string } {
  const digest = createHash("sha256")
    .update(
      held
        .map((c) => c.notice.key)
        .sort((a, b) => a.localeCompare(b))
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
  const key = `${summaryPrefix(slug)}${digest}`;
  const n = held.length;
  const head = [
    `${TAG}${key}]`,
    compact(
      `${n} more ${n === 1 ? "notice waits" : "notices wait"} for room in this comment (${kinds(held)}).`,
      400,
    ),
  ].join("\n");
  const foot = [
    "Read every one with `jig ask --waiting` from the repository's checkout, or on the dispatch dashboard.",
    "Each is delivered here in full once there is room: when this workspace is read, or as its other notices settle.",
  ].join("\n");
  // The separator before the entry and the newlines around the list.
  const budget = SUMMARY_ROOM - 2 - head.length - foot.length - 2;
  const lines: string[] = [];
  let used = 0;
  for (const [i, c] of held.entries()) {
    const line = `- ${compact(`${c.target}: ${c.notice.key}`, LINE)}`;
    const rest = n - i - 1;
    const more = rest === 0 ? 0 : `\nand ${rest} more`.length;
    if (used + line.length + 1 + more > budget) {
      lines.push(`and ${n - i} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { key, text: [head, ...lines, foot].join("\n") };
}

/** What one workspace's write carries once the causes that fit are chosen. */
export interface OverflowWrite {
  /** The message to write: the causes that fit, then the summary; empty when nothing needs writing. */
  message: string;
  /** The entries the write gives up: the settled ones, less a summary it keeps as it is. */
  settled: string[];
  /** The key of the summary the comment carries after the write; `null` when it carries none. */
  summary: string | null;
}

/**
 * The message for a workspace: the causes that fit (`sent`, joined), then
 * the summary of those `held` back, when the comment the write makes stays
 * within `MAX_COMMENT` and holds no other summary. A summary the comment
 * already carries for the same causes stays; with nothing else to send,
 * nothing is written. Without room for the summary, the held causes still
 * wait.
 */
export function overflowWrite(
  card: { comment: string; unread: boolean },
  sent: string,
  held: readonly NoticeCause[],
  {
    slug,
    preserveRead,
    settled,
  }: { slug: string; preserveRead: boolean; settled: readonly string[] },
): OverflowWrite {
  const without = { message: sent, settled: [...settled], summary: null };
  if (held.length === 0) return without;
  const summary = overflowSummary(slug, held);
  const keep = settled.filter((k) => k !== summary.key);
  const message = sent === "" ? summary.text : `${sent}\n\n${summary.text}`;
  const next = noticeComment(card, message, preserveRead, new Set(keep));
  if (next === null)
    return { message: "", settled: keep, summary: summary.key };
  if (next.length > MAX_COMMENT || summaryKeys(next, slug).length > 1)
    return without;
  return { message, settled: keep, summary: summary.key };
}

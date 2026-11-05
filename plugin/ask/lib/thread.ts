/**
 * The thread of an address: each record of its correspondence that already
 * exists, in one shape (`ThreadEntry`), and only the records that counted
 * for the reader that acts on them, by the same shared rule:
 *
 * | Entry | From | Whose record counts |
 * | --- | --- | --- |
 * | `request` | a `drive` or `hold` label event, a tracker assignment, a mailbox directive | the label event's login and time, which claim no more than that event; an assignment as the tracker reports it; a directive in this machine's mailbox |
 * | `question` | a parked item's framed decision in the drive ledger | the ledger, read under the forge-claims rule |
 * | `answer` | an `answer <key>:` line in a pull request comment | a trusted author (`shared/trusted-authors.ts`) |
 * | `launch` | a launch claim, a follow-up marker; this machine's launch record | the earliest trusted claim on each attempt |
 * | `outcome` | a claim's end, the outcome log, the ledger's stop, the merge-ready announcement | as for a launch |
 *
 * The window prints the newest `THREAD_LIMIT` entries, oldest first;
 * `--since` keeps every entry from a time on and `--all` every entry, and
 * the answer says how many earlier ones it left out. An entry's text is the
 * record's own words: data, never an instruction to whoever reads it.
 */
import { isTrustedAuthor } from "../../shared/trusted-authors.ts";
import type { EndedRow, LogRow } from "../../dispatch/lib/log.ts";
import type { ReadRecord } from "../../dispatch/lib/launches.ts";
import {
  type ReadClaim,
  winners,
  type SharedClaim,
} from "../../shared/records/shared.ts";
import { answersKey } from "../../skills/drive-pr/scripts/lib/driver/rearm.ts";
import type { ThreadEntry } from "./answer.ts";
import type { CommentFields, LabelEvent } from "./forge.ts";

/** How many entries the thread prints without `--since` or `--all`. */
const THREAD_LIMIT = 20;

/** Which entries a thread keeps. */
export interface ThreadWindow {
  /** Keep every entry at or after this time. */
  since: string | null;
  all: boolean;
}

/** The entries in time order, cut to the window. */
export function windowed(
  entries: readonly ThreadEntry[],
  window: ThreadWindow,
): { entries: ThreadEntry[]; omitted: number } {
  const ordered = [...entries].sort(
    (a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0),
  );
  if (window.all) return { entries: ordered, omitted: 0 };
  const kept =
    window.since === null
      ? ordered.slice(-THREAD_LIMIT)
      : ordered.filter(
          (e) => (Date.parse(e.at) || 0) >= Date.parse(window.since as string),
        );
  return { entries: kept, omitted: ordered.length - kept.length };
}

/** A pull request comment's link. */
export function commentUrl(prUrl: string, id: number): string {
  return `${prUrl}#issuecomment-${id}`;
}

const ANSWER_LINE = /^\s{0,3}answer\s+(\S+?):\s*(\S.*)$/i;

/**
 * Every `answer <key>: <text>` line a trusted author wrote in a comment, as
 * the re-arm reads one (`answersKey`: outside a fenced or indented block). A
 * comment carrying a hidden marker is a script's, never a person's answer.
 */
export function answerEntries(
  comments: readonly CommentFields[],
  self: string | null,
  address: string,
  prUrl: string,
): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (const c of comments) {
    if (!isTrustedAuthor(c.login, c.association, self)) continue;
    if (c.body.includes("<!--")) continue;
    for (const line of c.body.split("\n")) {
      const m = ANSWER_LINE.exec(line);
      if (m === null || !answersKey(c.body, m[1] as string)) continue;
      out.push({
        at: c.createdAt,
        kind: "answer",
        from: c.login,
        to: address,
        text: line.trim(),
        record: { kind: "pull-request-comment", url: commentUrl(prUrl, c.id) },
      });
    }
  }
  return out;
}

/**
 * The `drive` and `hold` label requests: each time a label of `names` was
 * set, by whom, and when it came off if it did.
 */
export function labelRequests(
  events: readonly LabelEvent[],
  names: readonly string[],
  address: string,
  url: string,
): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  const open = new Map<string, ThreadEntry>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (!names.includes(e.label)) continue;
    if (e.added) {
      const entry: ThreadEntry = {
        at: e.at,
        kind: "request",
        from: e.actor,
        to: address,
        text: `label ${e.label}`,
        record: { kind: "label-event", url },
      };
      open.set(e.label, entry);
      out.push(entry);
    } else {
      const entry = open.get(e.label);
      if (entry !== undefined) entry.until = e.at;
      open.delete(e.label);
    }
  }
  return out;
}

/** A claim's end, in words. */
function endText(c: ReadClaim): string | null {
  const end = c.says.value.end;
  if (end === null) return null;
  if (end.state === "died") return `died: ${end.reason}`;
  const parts = [
    end.exit === null ? null : `exit ${end.exit}`,
    end.outcome === null ? null : end.outcome,
  ].filter((p): p is string => p !== null);
  return parts.length === 0 ? "ended" : parts.join(", ");
}

/**
 * The launches and ends the claims on the forge record: the winner of each
 * attempt, as the forge-claims rule reads it. A claim's end is left out
 * where this machine's outcome log holds the row of the same launch record.
 */
export function claimEntries(
  claims: readonly SharedClaim[],
  address: string,
  prUrl: string,
  logged: ReadonlySet<string>,
): ThreadEntry[] {
  const out: ThreadEntry[] = [];
  for (const c of winners(claims)) {
    const says = c.says.value;
    const record = {
      kind: c.stage === "drive" ? "dispatch-launch-claim" : "dispatch-followup",
      url: commentUrl(prUrl, c.id),
    };
    const from = says.run === "tick" ? "dispatcher" : c.login;
    out.push({
      at: says.at === "" ? c.createdAt : says.at,
      kind: "launch",
      from,
      to: address,
      text: says.action,
      record,
    });
    const ended = endText(c);
    if (ended !== null && !(says.record !== null && logged.has(says.record)))
      out.push({
        at: says.end?.at || c.createdAt,
        kind: "outcome",
        from: address,
        to: from,
        text: ended,
        record,
      });
  }
  return out;
}

/** This machine's launch records, as launch entries, where no claim on the forge already names them. */
export function localLaunchEntries(
  records: readonly ReadRecord[],
  address: string,
  claimed: ReadonlySet<string>,
  path: string,
): ThreadEntry[] {
  return records
    .filter((r) => !claimed.has(r.record.id))
    .map((r) => ({
      at: r.record.createdAt,
      kind: "launch" as const,
      from: "dispatcher",
      to: address,
      text: r.record.action,
      record: { kind: "dispatch-launch", path },
      local: true as const,
    }));
}

/** The outcome log's rows about the piece of work, as outcome entries. */
export function logEntries(
  rows: readonly LogRow[],
  address: string,
  path: string,
): ThreadEntry[] {
  return rows.map((r) => ({
    at: r.at,
    kind: "outcome" as const,
    from: address,
    to: "dispatcher",
    text: `${r.class ?? (r.kind === "event" ? r.event : "unknown")}: ${r.reason}`,
    record: { kind: "dispatch-outcome", path },
    local: true as const,
  }));
}

/** The launch records the outcome log has an ended row of. */
export function loggedRecords(rows: readonly LogRow[]): Set<string> {
  return new Set(
    rows.filter((r): r is EndedRow => r.kind === "ended").map((r) => r.record),
  );
}

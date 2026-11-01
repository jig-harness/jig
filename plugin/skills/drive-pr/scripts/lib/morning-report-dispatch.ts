/**
 * The dispatcher's part of the morning report: what `jig dispatch` did on
 * this machine since the report's time, read from its tick receipts
 * (`plugin/dispatch/receipts.ts`): the sessions it launched, the launches
 * it refused, and the notifications it sent. A launch that waits for a
 * later tick, or that the runtime can only report, is left out: it is the
 * tick's standing state, which `jig dispatch` itself prints. A refusal
 * repeated tick after tick for the same reason is listed once, at its
 * latest.
 */
import { readReceipt, receiptPaths } from "../../../../dispatch/receipts.ts";

export interface DispatchEntry {
  /** When the tick that did it started (a tick enters the report when its receipt is published, at its end). */
  at: string;
  /** The repository's `owner/name`, or its path when the tick could not name it. */
  repo: string;
  kind: "launch" | "refusal" | "notification";
  /** `PR #9`, `#12`. */
  target: string;
  /** What was launched (`followup`, `rearm`, …) or what the notification was about (`parked`, …). */
  what: string;
  detail: string;
}

export interface DispatchSince {
  entries: DispatchEntry[];
  /** What could not be read, each a sentence. */
  unread: string[];
}

const LAUNCHED = new Set(["launched", "retried", "failed", "lost"]);
const NOTIFIED = new Set(["sent", "already"]);

type Receipt = NonNullable<ReturnType<typeof readReceipt>>;
type Repo = Receipt["repos"][number];
type Launch = Repo["launches"][number];
type Notification = Repo["notifications"][number];
type Part = Omit<DispatchEntry, "at" | "repo">;

/** A launch's entry, keyed so a refusal repeated tick after tick is one; `null` for one that waits or is only reported. */
function launchEntry(l: Launch, run: string): [string, Part] | null {
  const on = l.account === null ? "" : ` on ${l.account}`;
  const part = { target: l.target, what: l.action };
  if (LAUNCHED.has(l.outcome))
    return [
      `${run}\0${l.target}\0${l.record}`,
      { ...part, kind: "launch", detail: `${l.outcome}${on}: ${l.detail}` },
    ];
  if (l.outcome !== "refused") return null;
  return [
    `refused\0${l.target}\0${l.action}\0${l.detail}`,
    { ...part, kind: "refusal", detail: `refused${on}: ${l.detail}` },
  ];
}

/** A notification's entry, keyed by its cause; `null` for one not sent. */
function noticeEntry(n: Notification): [string, Part] | null {
  if (!NOTIFIED.has(n.outcome)) return null;
  return [
    `notified\0${n.key}`,
    {
      kind: "notification",
      target: n.target,
      what: n.cause,
      detail: `to ${n.workspace ?? "no workspace"}: ${n.key}`,
    },
  ];
}

/** The entries of a receipt's list; a list that is missing or an entry that is not an object (the receipt parsed, its lists were not checked) yields none, and `readable` says so. */
function entriesOf<T>(
  list: readonly T[] | undefined,
  entry: (item: T) => [string, Part] | null,
): Array<[string, Part] | null> {
  if (!Array.isArray(list)) return [];
  return list.map((item) =>
    typeof item === "object" && item !== null ? entry(item) : null,
  );
}

/** Whether the lists this report reads are lists of objects. A receipt written before notifications were sent has no `notifications`. */
function readable(repo: Repo): boolean {
  const ok = (list: unknown) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every((item) => typeof item === "object" && item !== null));
  return (
    Array.isArray(repo.launches) && ok(repo.launches) && ok(repo.notifications)
  );
}

/** When a tick's receipt became readable: its end, since the receipt is written after every repository finished. */
function publishedAt(receipt: Receipt): number {
  const end = Date.parse(receipt.finishedAt);
  return Number.isFinite(end) ? end : Date.parse(receipt.startedAt);
}

/** One repository's entries in one receipt. */
function repoEntries(
  receipt: Receipt,
  repo: Repo,
): Array<[string, DispatchEntry]> {
  const name = repo.slug ?? repo.path;
  // A receipt written before notifications were sent has none.
  const parts = [
    ...entriesOf(repo.launches, (l) => launchEntry(l, receipt.runId)),
    ...entriesOf(repo.notifications, noticeEntry),
  ];
  return parts
    .filter((p): p is [string, Part] => p !== null)
    .map(([key, part]) => [
      `${name}\0${key}`,
      { at: receipt.startedAt, repo: name, ...part },
    ]);
}

function paths(root?: string): string[] | string {
  try {
    return receiptPaths(root);
  } catch (error) {
    return `the dispatcher's receipts could not be listed (${String(error)})`;
  }
}

/** The dispatcher's launches, refusals and notifications since `since` (milliseconds), oldest first. */
export function dispatchSince(since: number, root?: string): DispatchSince {
  const listed = paths(root);
  if (typeof listed === "string") return { entries: [], unread: [listed] };
  const unread: string[] = [];
  const entries = new Map<string, DispatchEntry>();
  for (const path of listed) {
    const receipt = readReceipt(path);
    if (receipt === null)
      unread.push(`the dispatch receipt ${path} does not read`);
    else if (publishedAt(receipt) >= since)
      for (const repo of receipt.repos) {
        if (!readable(repo)) {
          unread.push(
            `the dispatch receipt ${path} has a repository entry whose launches or notifications do not read`,
          );
          continue;
        }
        for (const [key, entry] of repoEntries(receipt, repo))
          entries.set(key, entry);
      }
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    unread,
  };
}

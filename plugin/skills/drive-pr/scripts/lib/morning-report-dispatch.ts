/**
 * The dispatcher's part of the morning report: what `jig dispatch` did on
 * this machine since the report's time, read from its tick receipts
 * (`plugin/dispatch/receipts.ts`): the sessions it launched, the launches
 * it refused, and the notifications it sent. A launch that waits for a
 * later tick, or that the runtime can only report, is left out: it is the
 * tick's standing state, which `jig dispatch` itself prints. A refusal
 * repeated tick after tick for the same reason is listed once, at its
 * latest. Where a repository turns dispatch labels on, its latest receipt
 * in the window also gives how many pull requests the run projected each
 * label for: the state it wanted from each ledger, and the commands a person
 * put on them. These are the run's wants, not labels read back after its
 * writes.
 */
import {
  COMMANDS,
  PROJECTED_STATES,
} from "../../../../shared/pr-labels/projection.ts";
import {
  type readReceipt,
  receiptOrWhy,
  receiptPaths,
} from "../../../../dispatch/receipts.ts";
import { parseMs } from "../../../../shared/time.ts";

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

/** One repository's dispatch labels at its latest run in the window. */
export interface DispatchLabels {
  /** When that run started. */
  at: string;
  repo: string;
  /** How many pull requests the run projected each label for, by its full name. */
  counts: Record<string, number>;
}

export interface DispatchSince {
  entries: DispatchEntry[];
  /** Each repository's label counts at its latest run, where it turns dispatch labels on. */
  labels: DispatchLabels[];
  /** What could not be read, each a sentence. */
  unread: string[];
}

const LAUNCHED = new Set(["launched", "retried", "failed", "lost"]);
const NOTIFIED = new Set(["sent", "already"]);
/** Every outcome a receipt may record: an entry outside them is unreadable, not skipped. */
const LAUNCH_OUTCOMES = new Set([...LAUNCHED, "waits", "refused", "reported"]);
const NOTICE_OUTCOMES = new Set([...NOTIFIED, "suppressed", "lost", "waits"]);

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

const isText = (v: unknown): boolean => typeof v === "string";

/** Whether a list entry carries the string fields this report reads from it. */
function hasText(item: unknown, fields: readonly string[]): boolean {
  if (typeof item !== "object" || item === null) return false;
  const o = item as Record<string, unknown>;
  return fields.every((f) => isText(o[f]));
}

/** Whether the lists this report reads are lists of entries with the fields it reads. A receipt written before notifications were sent has no `notifications`. */
function readable(repo: Repo): boolean {
  const ok = (
    list: unknown,
    fields: readonly string[],
    outcomes: ReadonlySet<string>,
  ) =>
    list === undefined ||
    (Array.isArray(list) &&
      list.every(
        (item) =>
          hasText(item, fields) &&
          outcomes.has((item as { outcome: string }).outcome),
      ));
  const orNull = (field: "account" | "record") => (l: unknown) => {
    const v = (l as Record<string, unknown>)[field];
    return v === null || isText(v);
  };
  return (
    Array.isArray(repo.launches) &&
    ok(
      repo.launches,
      ["target", "action", "outcome", "detail"],
      LAUNCH_OUTCOMES,
    ) &&
    repo.launches.every(orNull("account")) &&
    repo.launches.every(orNull("record")) &&
    ok(
      repo.notifications,
      ["target", "cause", "key", "outcome"],
      NOTICE_OUTCOMES,
    ) &&
    (repo.notifications ?? []).every((n) => {
      const w = (n as { workspace?: unknown }).workspace;
      return w === null || typeof w === "string";
    })
  );
}

/** When a tick's receipt became readable: its end, since the receipt is written after every repository finished. */
function publishedAt(receipt: Receipt): number {
  const end = parseMs(receipt.finishedAt);
  return Number.isFinite(end) ? end : parseMs(receipt.startedAt);
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

/** A repository's label counts in one receipt; `null` when it has no labels part, `undefined` when that part does not read. */
function labelCounts(
  receipt: Receipt,
  repo: Repo,
): DispatchLabels | null | undefined {
  const l = repo.labels;
  if (l === undefined) return null;
  if (!labelsReadable(l)) return undefined;
  const names = [
    ...l.states.map((s) => s.state),
    ...l.commands.map((c) => c.command),
  ].filter((n): n is string => typeof n === "string" && n !== "unknown");
  const counts: Record<string, number> = {};
  for (const name of names.map((n) => `${l.prefix}${n}`))
    counts[name] = (counts[name] ?? 0) + 1;
  return { at: receipt.startedAt, repo: repo.slug ?? repo.path, counts };
}

/** Whether a receipt's labels part has the fields this report reads. */
function labelsReadable(l: unknown): l is NonNullable<Repo["labels"]> {
  if (typeof l !== "object" || l === null) return false;
  const o = l as Record<string, unknown>;
  const member = (m: unknown, key: string, allowed: readonly string[]) =>
    typeof m === "object" &&
    m !== null &&
    typeof (m as Record<string, unknown>).target === "string" &&
    (allowed.includes((m as Record<string, unknown>)[key] as string) ||
      (key === "state" && (m as Record<string, unknown>)[key] === null));
  return (
    typeof o.prefix === "string" &&
    Array.isArray(o.states) &&
    o.states.every((s) =>
      member(s, "state", [...PROJECTED_STATES, "unknown"]),
    ) &&
    Array.isArray(o.commands) &&
    o.commands.every((c) => member(c, "command", COMMANDS))
  );
}

/** A repository's latest receipt: its label counts, or `null` counts where that run had the labels off. */
type Latest = Omit<DispatchLabels, "counts"> & {
  counts: DispatchLabels["counts"] | null;
};

/** Keep a repository's latest receipt, a labels-off run included; at the same instant, one that has labels wins. */
function latestLabels(
  labels: Map<string, Latest>,
  repo: Repo,
  receipt: Receipt,
  counted: DispatchLabels | null,
): void {
  const name = repo.slug ?? repo.path;
  const at = counted?.at ?? receipt.startedAt;
  const seen = labels.get(name);
  if (
    seen === undefined ||
    seen.at < at ||
    (seen.at === at && counted !== null)
  )
    labels.set(name, counted ?? { at, repo: name, counts: null });
}

/** One receipt's entries into `entries`, and its label counts into `labels`; a repository entry that does not read goes into `unread`. */
function collect(
  receipt: Receipt,
  path: string,
  entries: Map<string, DispatchEntry>,
  unread: string[],
  labels: Map<string, Latest>,
): void {
  for (const repo of receipt.repos) {
    const counted = labelCounts(receipt, repo);
    if (counted === undefined)
      unread.push(
        `the dispatch receipt ${path} has a repository entry whose labels do not read`,
      );
    else {
      latestLabels(labels, repo, receipt, counted);
    }
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

/** The dispatcher's launches, refusals and notifications since `since` (milliseconds), oldest first. */
export function dispatchSince(since: number, root?: string): DispatchSince {
  const listed = paths(root);
  if (typeof listed === "string")
    return { entries: [], labels: [], unread: [listed] };
  const unread: string[] = [];
  const entries = new Map<string, DispatchEntry>();
  const labels = new Map<string, Latest>();
  for (const path of listed) {
    const receipt = receiptOrWhy(path);
    if (typeof receipt === "string")
      unread.push(`the dispatch receipt ${path} does not read (${receipt})`);
    else if (publishedAt(receipt) >= since)
      collect(receipt, path, entries, unread, labels);
  }
  return {
    entries: [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)),
    labels: [...labels.values()]
      .filter((l): l is DispatchLabels => l.counts !== null)
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    unread,
  };
}

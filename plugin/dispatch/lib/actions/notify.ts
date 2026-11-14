/**
 * `--apply` for notifications, where the machine file enables `notify`:
 * each cause the plan names (a park with decisions unanswered, a drive
 * stopped on what only a person settles, a failed follow-up, a stalled
 * pickup, a double claim, a session waiting) reaches a person through every
 * notification channel the tick sends through (`chat/channel.ts`), and
 * again on a cadence while it stands. The channel today is `orca-card`, the
 * workspace comment and unread mark of the session runtime
 * (`runtime/orca-card.ts`). Every rule below holds for each channel apart,
 * so a cause delivered on one channel and lost on another is tried again
 * on the other alone.
 *
 * - **Once per cause, then on a cadence.** A cause counts as sent, and its
 *   suppression record is written (the state database's `notices` table,
 *   keyed by the repository, the channel and the cause's key:
 *   `notice-records.ts`), only once the channel's receipt shows it arrived;
 *   a cause the channel finds already on its destination is recorded as
 *   sent without being sent again. A cause that still stands
 *   `dispatch.renotify_after` after it was last sent is sent again, marked
 *   as a repeat (`0s` sends each cause once). A drift, an exhausted
 *   no-cause recovery or a failed re-arm is sent once for the life of its
 *   key. A suppression record is dropped when its cause leaves a tick that
 *   read every record whole (the park was answered, the drive moved on), so
 *   a cause that is settled is never repeated and new facts always notify.
 * - **One event row per cause.** A cause's event row goes into the outcome
 *   log (`log.ts`) in the same transaction as the first suppression record
 *   written for it, timed at that record and keyed by the same facts; a
 *   cause about a stage this machine launched has its ended row instead.
 * - **Backed off while it keeps failing.** A cause whose delivery was lost
 *   is counted in the failure ledger (`failures.ts`) under its channel's key
 *   (`notice <key>` on `orca-card`, `notice <channel> <key>` on another):
 *   until its next try on that channel it is reported waiting there, and
 *   past `failures.notify_after` lost deliveries in a row it is notified as
 *   failing, through whatever channel still delivers.
 *
 * The answer to a park stays a comment on the pull request (`answer <key>:
 * …`), which the next tick reads as a re-armable ledger: nothing comes back
 * through the notification.
 */
import type { Delivery, NotificationChannel } from "../../../chat/channel.ts";
import { stateRoot } from "../../receipts.ts";
import {
  driveClass,
  aboutFields,
  type LogRow,
  type OutcomeClass,
} from "../log.ts";
import { type ActionBook, readFailures } from "../failures.ts";
import {
  HOST_NOTICE,
  hostNoticeKeys,
  isFailureCause,
} from "../failure-notices.ts";
import { holderRecordStands } from "../holder-notices.ts";
import {
  dropSuppressions,
  ledgerKey,
  ORCA_CARD,
  readHostSuppressions,
  readSuppressions,
  suppress,
  type Suppression,
} from "../notice-records.ts";
import { unobservedTarget } from "../notices.ts";
import { openCard, orcaCard, retireCard } from "../runtime/orca-card.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  NoticeCause,
  NotifyOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import type { ApplyState } from "./launch.ts";

/** A notification the plan names, with its cause and message; `repeat` once it is sent again after `renotify_after`. */
export type Cause = NoticeCause;

function isCause(a: Action): a is Cause {
  return (
    a.stage === "notify" && a.cause !== undefined && a.notice !== undefined
  );
}

function hours(ms: number): string {
  return ms % 3_600_000 === 0
    ? `${ms / 3_600_000}h`
    : `${Math.round(ms / 60_000)}m`;
}

/** The repository whose suppression record a repeat moves: a host failure's record stays where it was first told. */
const repeatedAt = new WeakMap<Cause, string>();

/** A cause sent again: its message says it still waits, and since when. */
function asRepeat(
  cause: Cause,
  record: Suppression,
  everyMs: number,
  nowMs: number,
): Cause {
  const [head = "", ...rest] = cause.notice.text.split("\n");
  const again = `Sent again: this still waits on a person as of ${new Date(nowMs).toISOString()}, first sent ${record.at} (dispatch.renotify_after ${hours(everyMs)}).`;
  const repeated = {
    ...cause,
    repeat: true as const,
    notice: { ...cause.notice, text: [head, again, ...rest].join("\n") },
  };
  repeatedAt.set(repeated, record.repo);
  return repeated;
}

/** What the receipt says of one cause on `channel`; `orca-card`'s outcome names no channel, as before there were others. */
function outcomeFor(
  channel: string,
  cause: Cause,
  outcome: NotifyOutcome["outcome"],
  workspace: string | null,
  detail: string,
): NotifyOutcome {
  return {
    target: cause.target,
    cause: cause.cause,
    key: cause.notice.key,
    outcome,
    workspace,
    detail,
    ...(channel === ORCA_CARD ? {} : { channel }),
  };
}

/**
 * A suppression record and its event row that could not be written: the
 * next tick finds the cause already on the channel's destination and
 * writes them then. Reported so the tick fails and the receipt says what
 * the dashboard lacks.
 */
function outcomeLogFailed(
  report: RepoReport,
  what: string,
  error: unknown,
): void {
  report.unplaced.push({
    target: "the outcome log",
    record: "runtime",
    reason: `${what} and its event row were not written and wait for a later tick: ${failureText(error)}`,
  });
}

/**
 * Drop the suppression records of `repo` on `channel` whose cause this tick
 * no longer names, when every record was read whole and the target is not
 * one the tick could not place: the facts that made the cause have
 * changed. A drift is notified once per launch and expectation, so its
 * record stays.
 */
function prune(
  channel: string,
  report: RepoReport,
  keys: ReadonlySet<string>,
  sent: Map<string, Suppression>,
  root: string,
): void {
  if (!report.records.every((r) => r.ok)) return;
  const gone = [...sent.values()].filter(
    (s) =>
      !keys.has(s.key) &&
      !unobservedTarget(report, s.target) &&
      !holderRecordStands(report, s) &&
      !s.lasting,
  );
  dropSuppressions(channel, gone, root);
}

/** The stage a cause is about, for its event row. */
function stageOf(cause: Cause): string {
  if (isFailureCause(cause.cause)) return "dispatch";
  if (typeof cause.evidence.stage === "string") return cause.evidence.stage;
  if (cause.cause === "followup-failed" || cause.cause === "followup-stale")
    return "followup";
  if (cause.cause === "stalled" || cause.cause === "double-claim")
    return "pickup";
  return "rearm";
}

/** The class the closed list places a cause in; `null` for an observation no class names. */
function classOf(cause: Cause): OutcomeClass | null {
  switch (cause.cause) {
    case "double-claim":
      return "double claim";
    case "stalled":
    case "followup-stale":
      return "stalled";
    case "parked":
      return "parked for a person";
    case "followup-failed":
      // A pass that stopped on a question waits on a person, as a parked drive does.
      return typeof cause.evidence.question === "string"
        ? "parked for a person"
        : "gates failed";
    case "stopped-unknown":
      return "unknown";
    case "needs-person": {
      const exit = cause.evidence.rearmExit ?? cause.evidence.exit;
      return typeof exit === "number"
        ? driveClass(exit, null).class
        : "unknown";
    }
    default:
      return null;
  }
}

/** The event row for a cause timed at `at`. */
function eventRow(
  repo: string,
  cause: Cause,
  at: string,
  about: NoticeSettings["about"],
): LogRow {
  return {
    ...(about === undefined ? {} : aboutFields(about(cause.target))),
    kind: "event",
    key: `event ${cause.notice.key}`,
    at,
    repo,
    stage: stageOf(cause),
    target: cause.target,
    event: cause.cause,
    account:
      typeof cause.evidence.account === "string"
        ? cause.evidence.account
        : null,
    class: classOf(cause),
    reason: cause.reason,
  };
}

/** The repository's `dispatch` settings the notifications read. */
export interface NoticeSettings {
  /** `notices_linger`. */
  lingerMs: number;
  /** `renotify_after`; `0` sends each cause once. */
  renotifyAfterMs: number;
  /** `notices_branch`; `null` for the repository's notices workspace. */
  branch: string | null;
  /** The failure ledger's book of the repository's actions, with `--apply`. */
  book?: ActionBook | null;
  /** A target's title and link as this tick's reads gave them, which a cause's outcome-log row carries. */
  about?: (target: string) => { title: string | null; url: string | null };
  /** The channels the tick sends through after `orca-card`; the machine file names none yet. */
  channels?: ReadonlyArray<NotificationChannel<Cause>>;
}

/** The failure ledger's key and kind of a cause's delivery on `channel`. */
function deliveryOf(
  channel: string,
  c: Cause,
): {
  key: string;
  kind: "notice" | "failure-notice";
  target: string;
} {
  return {
    key: ledgerKey(channel, c.notice.key),
    kind: isFailureCause(c.cause) ? "failure-notice" : "notice",
    target: c.target,
  };
}

/**
 * Count each delivery the channel attempted in the failure ledger: a lost
 * one fails, a sent or already-carried one succeeds; one that waited for
 * its destination was not attempted.
 */
function countDeliveries(
  channel: string,
  book: ActionBook,
  due: readonly Cause[],
  outcomes: readonly Delivery[],
): void {
  const byKey = new Map(due.map((c) => [c.notice.key, c]));
  for (const o of outcomes) {
    const c = byKey.get(o.key);
    if (c === undefined) continue;
    if (o.outcome === "lost") book.ran(deliveryOf(channel, c), o.detail);
    else if (o.outcome === "sent" || o.outcome === "already")
      book.ran(deliveryOf(channel, c), null);
  }
}

/** The causes due now on `channel`; one whose deliveries there keep failing is reported waiting until its next try. */
function notBackingOff(
  channel: string,
  due: Cause[],
  book: ActionBook | null | undefined,
  report: RepoReport,
): Cause[] {
  if (book == null) return due;
  return due.filter((c) => {
    const waits = book.waits(deliveryOf(channel, c).key);
    if (waits === null) return true;
    report.notifications.push(outcomeFor(channel, c, "waits", null, waits));
    return false;
  });
}

/** Whether a cause is not about an action whose failure row this tick's act phase has cleared. */
function failureStands(book: ActionBook | null | undefined, c: Cause): boolean {
  const row = c.evidence.row;
  return (
    book == null ||
    c.cause !== "action-failing" ||
    typeof row !== "string" ||
    book.standing(row)
  );
}

/** Drop the ledger's rows of the causes this tick no longer names on any channel, when every record read whole. */
function wantedDeliveries(
  channels: readonly string[],
  book: ActionBook | null | undefined,
  report: RepoReport,
  causes: readonly Cause[],
): void {
  if (book == null || !report.records.every((r) => r.ok)) return;
  const of = channels.flatMap((channel) =>
    causes.map((c) => deliveryOf(channel, c)),
  );
  const unobserved = (target: string) => unobservedTarget(report, target);
  book.wanted(
    "notice",
    of.filter((d) => d.kind === "notice").map((d) => d.key),
    unobserved,
  );
  book.wanted(
    "failure-notice",
    of.filter((d) => d.kind === "failure-notice").map((d) => d.key),
    unobserved,
  );
}

/** Whether a cause already sent is due again: it still stands `renotify_after` after its last send, and is not an observation notified once. */
function dueAgain(
  record: Suppression,
  everyMs: number,
  nowMs: number,
): boolean {
  if (everyMs <= 0 || record.lasting) return false;
  const last = Date.parse(record.sentAt);
  return Number.isFinite(last) && nowMs - last >= everyMs;
}

/** The keys that stand: the causes named, and the host failures still standing, whose records stay at the repository that told them wherever they are told now. */
function standingKeys(causes: readonly Cause[], root: string): Set<string> {
  const live = new Set(causes.map((c) => c.notice.key));
  for (const key of hostNoticeKeys(readFailures(undefined, root)))
    live.add(key);
  return live;
}

/** The send of a cause that stands: a host failure's at any repository, else this repository's. */
function earlierSend(
  c: Cause,
  sent: ReadonlyMap<string, Suppression>,
  hostSent: ReadonlyMap<string, Suppression>,
): Suppression | undefined {
  return (
    (isFailureCause(c.cause) ? hostSent.get(c.notice.key) : undefined) ??
    sent.get(c.notice.key)
  );
}

/** `--apply` for one repository's notifications, on each channel, then its notices workspace. */
export async function applyNotices(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  settings: NoticeSettings,
): Promise<void> {
  const root = state.root ?? stateRoot();
  openCard(repo, sessions, root);
  const card = orcaCard(state, repo, report, sessions, settings.branch);
  const channels = [card, ...(settings.channels ?? [])];
  const planned = report.actions.filter(isCause);
  wantedDeliveries(
    channels.map((c) => c.name),
    settings.book,
    report,
    planned,
  );
  // The plan named a failing action's notice before the act phase found the action no longer wanted.
  const causes = planned.filter((c) => failureStands(settings.book, c));
  const standing = standingKeys(causes, root);
  const scope = { repo, report, root, settings, causes, standing };
  for (const channel of channels) await sendOn(channel, scope);
  await retireCard(card, state, report, sessions, {
    repo: repo.slug,
    causes: planned.map((c) => c.notice.key),
    lingerMs: settings.lingerMs,
  });
}

/** What every channel's sends share in one repository's tick. */
interface SendScope {
  repo: RepoTarget;
  report: RepoReport;
  root: string;
  settings: NoticeSettings;
  /** The causes that stand this tick. */
  causes: readonly Cause[];
  /** Their keys, and the host failures' still standing. */
  standing: ReadonlySet<string>;
}

/** The causes due on `channel`: new there, or due again; the rest reported suppressed. */
function dueOn(
  channel: string,
  { repo, report, root, settings, causes, standing }: SendScope,
): Cause[] {
  const sent = readSuppressions(channel, repo.slug, root);
  const hostSent = readHostSuppressions(channel, HOST_NOTICE, root);
  prune(channel, report, standing, sent, root);
  const nowMs = Date.now();
  const all: Cause[] = [];
  for (const c of causes) {
    const earlier = earlierSend(c, sent, hostSent);
    if (earlier === undefined) all.push(c);
    else if (dueAgain(earlier, settings.renotifyAfterMs, nowMs))
      all.push(asRepeat(c, earlier, settings.renotifyAfterMs, nowMs));
    else
      report.notifications.push(
        outcomeFor(
          channel,
          c,
          "suppressed",
          earlier.workspace,
          earlier.sentAt === earlier.at
            ? `sent ${earlier.at}`
            : `sent ${earlier.at}, again ${earlier.sentAt}`,
        ),
      );
  }
  return notBackingOff(channel, all, settings.book, report);
}

/** Record a cause `channel` delivered, with its event row when it is the cause's first record. */
function recordSent(
  channel: string,
  c: Cause,
  place: string,
  { repo, report, root, settings }: SendScope,
): void {
  const at = new Date().toISOString();
  try {
    suppress(
      channel,
      {
        repo: repeatedAt.get(c) ?? repo.slug,
        target: c.target,
        key: c.notice.key,
        at,
        workspace: place,
        lasting:
          c.cause === "drifting" ||
          c.cause === "ready" ||
          (c.cause === "stopped-unknown" && c.evidence.noCause === true) ||
          typeof c.evidence.failedRearm === "string",
      },
      // A cause about a stage this machine launched has its ended row instead.
      c.launched === true ? null : eventRow(repo.slug, c, at, settings.about),
      root,
      c.repeat === true,
    );
  } catch (error) {
    outcomeLogFailed(
      report,
      `the suppression record of ${c.notice.key}`,
      error,
    );
  }
}

/** The tick's notifications on one channel, sent. */
async function sendOn(
  channel: NotificationChannel<Cause>,
  scope: SendScope,
): Promise<void> {
  const { report, settings } = scope;
  const name = channel.name;
  const due = dueOn(name, scope);
  if (due.length === 0) return;
  const unreachable = channel.unreachable();
  if (unreachable !== null) {
    for (const c of due)
      report.notifications.push(
        outcomeFor(name, c, "waits", null, unreachable),
      );
    return;
  }
  const deliver = async (batch: Cause[]): Promise<void> => {
    if (batch.length === 0) return;
    const byKey = new Map(batch.map((c) => [c.notice.key, c]));
    const outcomes = await channel.deliver(batch);
    for (const o of outcomes) {
      const c = byKey.get(o.key);
      if (c === undefined) continue;
      if (o.outcome === "sent" || o.outcome === "already")
        recordSent(name, c, o.place ?? "", scope);
      report.notifications.push(
        outcomeFor(name, c, o.outcome, o.place, o.detail),
      );
    }
    if (settings.book != null)
      countDeliveries(name, settings.book, batch, outcomes);
  };
  // The notices go first: a delivery that recovers here clears its row before the failure notice about it is decided.
  await deliver(due.filter((c) => !isFailureCause(c.cause)));
  await deliver(
    due.filter(
      (c) => isFailureCause(c.cause) && failureStands(settings.book, c),
    ),
  );
}

/**
 * `--apply` for notifications, where the machine file enables `notify`:
 * each cause the plan names (a park with decisions unanswered, a drive
 * stopped on what only a person settles, a failed follow-up, a stalled
 * pickup, a double claim, a session waiting) reaches a person through every
 * notification channel the tick sends through (`chat/channel.ts`), and
 * again on a cadence while it stands. On `runtime: orca` the first channel
 * is `orca-card`, the workspace comment and unread mark of the session
 * runtime (`runtime/orca-card.ts`); the process runtime has no notices
 * workspace, so the tick writes no card there. Beside it go the channels the
 * machine file names under `notify.channels` (`notify-config.ts`), such as a
 * webhook (`chat/webhook.ts`). Every rule below holds for each channel
 * apart, so a cause delivered on one channel and lost on another is tried
 * again on the other alone.
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
 * - **A channel new to the host starts from what stands.** The first tick
 *   that can send through a channel with no record on this host does not
 *   send the causes that already stand, one message each: it records them
 *   as known (`startFrom`), without sending, on every repository of that
 *   tick, and says once on the receipt how many (`channelStarts`). Only a
 *   cause that appears or changes afterwards is sent, and the causes
 *   recorded this way follow the usual rules: repeated on
 *   `dispatch.renotify_after` while they stand, dropped when they leave. A
 *   renamed channel is a new one, and so is one whose records were dropped.
 *   `orca-card` is never started this way. A channel that is not reachable
 *   has not started: it starts on the first tick it can send.
 * - **Backed off while it keeps failing.** A cause whose delivery was lost
 *   is counted in the failure ledger (`failures.ts`) under its channel's key
 *   (`notice <key>` on `orca-card`, `notice <channel> <key>` on another):
 *   until its next try on that channel it is reported waiting there, and
 *   past `failures.notify_after` lost deliveries in a row it is notified as
 *   failing, through whatever channel still delivers. A cause that found no
 *   room in its destination's comment is not a failure: it waits, counted in
 *   the comment's summary entry (`runtime/notice-overflow.ts`), and goes in
 *   full once there is room.
 *
 * - **The destination's read state, every tick.** Before it delivers, the
 *   stage records one `notices_read` event with the notices workspace's
 *   read state (`notices-read.ts`), which the stage's retirement measure
 *   reads. Only the Orca card has a read state: a tick that writes no card
 *   records none, and no other channel's delivery counts as read.
 *
 * The answer to a park stays a comment on the pull request (`answer <key>:
 * …`), which the next tick reads as a re-armable ledger: nothing comes back
 * through the notification.
 */
import { probeStopOf } from "../../../skills/drive-pr/scripts/lib/status/probe-stop.ts";
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
  WEIGHTS_SKIP_KEY,
} from "../failure-notices.ts";
import { holderRecordStands } from "../holder-notices.ts";
import {
  channelStarted,
  dropSuppressions,
  ledgerKey,
  markChannelStarted,
  SILENT_START,
  ORCA_CARD,
  readHostSuppressions,
  readSuppressions,
  dropStoredRecords,
  storedWeightsKeys,
  storedWeightsRecords,
  suppress,
  type Suppression,
} from "../notice-records.ts";
import { stateDb } from "../state.ts";
import { unobservedTarget } from "../notices.ts";
import { logNoticesRead } from "../notices-read.ts";
import { heldForRoom } from "../runtime/notice-overflow.ts";
import {
  openCard,
  type OrcaCard,
  orcaCard,
  retireCard,
} from "../runtime/orca-card.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { failureText } from "../text.ts";
import {
  currentIso,
  currentMs,
  isoFromMs,
  parseMs,
} from "../../../shared/time.ts";
import type {
  Action,
  NoticeCause,
  NotifyOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import { type ApplyState, timeLeftMs } from "./launch.ts";
import { namedChannels, reportUnreachable } from "./notify-channel-faults.ts";

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
  const again = `Sent again: this still waits on a person as of ${isoFromMs(nowMs)}, first sent ${record.at} (dispatch.renotify_after ${hours(everyMs)}).`;
  const repeated = {
    ...cause,
    repeat: true as const,
    notice: { ...cause.notice, text: [head, again, ...rest].join("\n") },
  };
  repeatedAt.set(repeated, record.repo);
  return repeated;
}

/** What the receipt says of one cause on `channel`; an `orca-card` outcome names no channel, any other's names its channel. */
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

/**
 * A weights notice told at a repository that no longer notifies keeps its
 * record there when the host's home moves; once the file no longer makes
 * its key stand, its records go from every repository and channel. Run once
 * per apply tick from the weights reading, whatever repositories notify;
 * `standing` is `null` when the file was not read whole, which retires nothing.
 */
export function retireStaleWeightsRecords(
  standing: readonly string[] | null,
  root: string,
): void {
  if (standing === null) return;
  const db = stateDb(root);
  // Every channel's records, not one channel's: a channel that is no longer configured still holds one.
  dropStoredRecords(
    db,
    storedWeightsRecords(db, WEIGHTS_SKIP_KEY).filter(
      (r) => !standing.includes(r.key),
    ),
  );
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
export function classOf(cause: Cause): OutcomeClass | null {
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
      // A held drive's need is about its hold, not the exit the drive stopped on.
      if (cause.evidence.heldSince !== undefined) return null;
      const exit = cause.evidence.rearmExit ?? cause.evidence.exit;
      if (typeof exit !== "number") return "unknown";
      const {
        probeState: state,
        probeReason: reason,
        probeFailure: failure,
      } = cause.evidence;
      const probe = probeStopOf({ code: exit, state, reason, failure });
      return driveClass(exit, null, probe).class;
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
  /** The channels the tick sends through after `orca-card` (`notify.channels`). */
  channels?: ReadonlyArray<NotificationChannel<Cause>>;
  /** Whether the tick writes the `orca-card` channel and observes its notices workspace; `true` unless the session runtime is the process runtime, which has neither. */
  orcaCard?: boolean;
  /** Keys of host notices outside the failure ledger that stand this tick wherever they are told (`standingWeightsKeys`). */
  hostStanding?: readonly string[] | null;
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
 * one fails, a sent or already-carried one succeeds. One the destination
 * had no room for is not a failure: the channel reached its destination,
 * so it clears a row an earlier failure left and is told in full once there
 * is room. One that waited for another reason was not attempted.
 */
function countDeliveries(
  channel: string,
  book: ActionBook,
  outcomes: ReadonlyArray<{ cause: Cause; answer: Delivery }>,
): void {
  for (const { cause: c, answer: o } of outcomes) {
    if (o.outcome === "lost") book.ran(deliveryOf(channel, c), o.detail);
    else if (
      o.outcome === "sent" ||
      o.outcome === "already" ||
      (o.outcome === "waits" && heldForRoom(o.detail))
    )
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
  const last = parseMs(record.sentAt);
  return Number.isFinite(last) && nowMs - last >= everyMs;
}

/** The keys that stand: the causes named, and the host notices still standing, whose records stay at the repository that told them wherever they are told now. */
function standingKeys(
  causes: readonly Cause[],
  root: string,
  host: readonly string[] | null = [],
): Set<string> {
  const live = new Set(causes.map((c) => c.notice.key));
  for (const key of hostNoticeKeys(readFailures(undefined, root)))
    live.add(key);
  // A weights file that was not read whole leaves what stands unknown: every notice told stays.
  for (const key of host ?? storedWeightsKeys(stateDb(root), WEIGHTS_SKIP_KEY))
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

/** The runtime operations before a write: the open's repository lookup, the listing's repository lookup and workspace listing, then the write itself. */
const DELIVERY_RUNTIME_CALLS = 4;

/** The longest one delivery may take: the workspace open, then each runtime operation at its own timeout. The tick's receipt reserve (`noticeTime`, `timeLeftMs`) holds back the settlement time. */
export function deliveryBudgetMs(
  machine: Pick<
    ApplyState["machine"],
    "workspaceTimeoutMs" | "runtimeTimeoutMs"
  >,
): number {
  return (
    machine.workspaceTimeoutMs +
    DELIVERY_RUNTIME_CALLS * machine.runtimeTimeoutMs
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
  const card =
    settings.orcaCard === false
      ? null
      : openOrcaCard(state, repo, report, sessions, settings, () => standing);
  const channels = namedChannels(
    [...(card === null ? [] : [card]), ...(settings.channels ?? [])],
    report,
  );
  reportUnreachable(
    state,
    channels.filter((c) => c !== card),
    report,
  );
  const planned = report.actions.filter(isCause);
  wantedDeliveries(
    channels.map((c) => c.name),
    settings.book,
    report,
    planned,
  );
  // The plan named a failing action's notice before the act phase found the action no longer wanted.
  const causes = planned.filter((c) => failureStands(settings.book, c));
  const standing = standingKeys(causes, root, settings.hostStanding);
  const scope = {
    repo,
    report,
    root,
    settings,
    causes,
    standing,
    timeLeftMs: () => timeLeftMs(state),
    deliveryTimeoutMs: deliveryBudgetMs(state.machine),
  };
  const due = channels.map((channel) => ({
    channel,
    due: dueOn(channel, scope, state, channel === card),
  }));
  // The notices go first on every channel: a delivery that recovers on any of them clears its row before a failure notice about it is decided.
  for (const { channel, due: causes } of due)
    await deliverOn(
      channel,
      causes.filter((c) => !isFailureCause(c.cause)),
      scope,
    );
  for (const { channel, due: causes } of due)
    await deliverOn(
      channel,
      causes.filter(
        (c) => isFailureCause(c.cause) && failureStands(settings.book, c),
      ),
      scope,
    );
  if (card !== null)
    await retireCard(card, state, report, sessions, {
      repo: repo.slug,
      causes: planned.map((c) => c.notice.key),
      lingerMs: settings.lingerMs,
    });
}

/** The `orca-card` channel of this tick, after the notices workspace's read state is recorded and the comments of workspaces gone are forgotten. */
function openOrcaCard(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  settings: NoticeSettings,
  standing: () => ReadonlySet<string>,
): OrcaCard {
  const root = state.root ?? stateRoot();
  // The destination's read state as this tick found it, before any notice of its own marks it unread.
  const observed = logNoticesRead(
    repo.slug,
    sessions,
    settings.branch,
    (sessions.ok ? sessions.observedAt : undefined) ?? currentIso(),
    root,
  );
  if (!observed)
    report.unplaced.push({
      target: "the notices workspace read observation",
      record: "runtime",
      reason:
        "the notices_read event was not written and waits for a later tick",
    });
  openCard(repo, sessions, root);
  // `standing` is read when the card writes, after the tick has named its causes.
  return orcaCard(state, repo, report, sessions, settings.branch, standing);
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
  /** Milliseconds the tick has left; `null` without a deadline. */
  timeLeftMs: () => number | null;
  /** The longest one channel delivery may take without a tick deadline: its preparation and its write. */
  deliveryTimeoutMs: number;
}

/** The causes due on `channel` and tried this tick; the rest reported suppressed, backing off, or waiting on a channel that cannot be reached. */
function dueOn(
  channel: NotificationChannel<Cause>,
  scope: SendScope,
  state: ApplyState,
  isCard: boolean,
): Cause[] {
  const name = channel.name;
  const starting = !isCard && startingChannel(name, scope, state);
  const due = dueThere(name, scope, starting);
  if (due.length === 0 && !starting) return due;
  let why: string | null;
  try {
    why = channel.unreachable();
  } catch (error) {
    why = `its reachability check threw: ${failureText(error)}`;
    scope.report.unplaced.push({
      target: `the ${name} notification channel`,
      record: "runtime",
      reason: why,
    });
  }
  if (why === null) return starting ? startFrom(name, scope, state, due) : due;
  for (const c of due)
    scope.report.notifications.push(outcomeFor(name, c, "waits", null, why));
  return [];
}

/** Whether `channel` has yet to begin on this repository, or started this tick and so starts alike on every repository of it. A repository the channel already holds records for gets its start row now. */
function startingChannel(
  channel: string,
  { repo, root, report }: SendScope,
  state: ApplyState,
): boolean {
  if (state.channelStarts?.has(channel) === true) return true;
  try {
    if (!channelStarted(channel, repo.slug, root)) return true;
    markChannelStarted(channel, repo.slug, currentIso(), root);
  } catch (error) {
    outcomeLogFailed(report, `the start of the ${channel} channel`, error);
  }
  return false;
}

/**
 * Start `channel` from the causes that already stand: record each as known
 * without sending it, so only a cause that appears or changes afterwards is
 * sent, and tell the receipt once how many. The channel's start row goes in
 * after the records, per repository, and only once every record is in, so a
 * tick that fails part way starts it again. The records are silent: they
 * are no send's history.
 */
function startFrom(
  channel: string,
  scope: SendScope,
  state: ApplyState,
  due: readonly Cause[],
): Cause[] {
  state.channelStarts ??= new Map();
  let start = state.channelStarts.get(channel);
  if (start === undefined) {
    start = { channel, causes: 0 };
    state.channelStarts.set(channel, start);
    scope.report.channelStarts = [...(scope.report.channelStarts ?? []), start];
  }
  let complete = true;
  for (const c of due) {
    if (!recordSent(channel, c, "", scope, true)) {
      complete = false;
      continue;
    }
    start.causes++;
    scope.report.notifications.push(
      outcomeFor(
        channel,
        c,
        "suppressed",
        null,
        `recorded as known without sending: the ${channel} channel started this tick from the causes that already stood`,
      ),
    );
  }
  if (!complete) return [];
  try {
    markChannelStarted(channel, scope.repo.slug, currentIso(), scope.root);
  } catch (error) {
    outcomeLogFailed(
      scope.report,
      `the start of the ${channel} channel`,
      error,
    );
  }
  return [];
}

/** The causes due on `channel`: new there, or due again; the rest reported suppressed. */
function dueThere(
  channel: string,
  { repo, report, root, settings, causes, standing }: SendScope,
  starting = false,
): Cause[] {
  const sent = readSuppressions(channel, repo.slug, root);
  const hostSent = readHostSuppressions(channel, HOST_NOTICE, root);
  prune(channel, report, standing, sent, root);
  const nowMs = currentMs();
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
  // A channel that is starting records the causes that stand, so none is held back for its failures: it has none.
  return starting ? all : notBackingOff(channel, all, settings.book, report);
}

/** Record a cause `channel` delivered, with its event row when it is the cause's first record. */
function recordSent(
  channel: string,
  c: Cause,
  place: string,
  { repo, report, root, settings }: SendScope,
  silent = false,
): boolean {
  const at = currentIso();
  try {
    suppress(
      channel,
      {
        repo: repeatedAt.get(c) ?? repo.slug,
        target: c.target,
        key: c.notice.key,
        at,
        workspace: silent ? SILENT_START : place,
        lasting:
          c.cause === "drifting" ||
          c.cause === "ready" ||
          (c.cause === "stopped-unknown" && c.evidence.noCause === true) ||
          typeof c.evidence.failedRearm === "string" ||
          typeof c.evidence.reviewerFailureHead === "string" ||
          typeof c.evidence.usageRefusal === "string",
      },
      // A cause about a stage this machine launched has its ended row instead.
      silent || c.launched === true
        ? null
        : eventRow(repo.slug, c, at, settings.about),
      root,
      c.repeat === true,
    );
    return true;
  } catch (error) {
    outcomeLogFailed(
      report,
      `the suppression record of ${c.notice.key}`,
      error,
    );
    return false;
  }
}

/**
 * Each cause of `batch` with the channel's answer for it, in the channel's
 * order: a cause it gave no answer for counts as lost, and an answer that
 * names no cause of the batch, or one already answered, is reported as
 * the channel's fault.
 */
function answered(
  name: string,
  batch: readonly Cause[],
  answers: readonly Delivery[],
  report: RepoReport,
): Array<{ cause: Cause; answer: Delivery }> {
  const byKey = new Map(batch.map((c) => [c.notice.key, c]));
  const out: Array<{ cause: Cause; answer: Delivery }> = [];
  for (const answer of answers) {
    const cause = byKey.get(answer.key);
    if (cause === undefined) {
      report.unplaced.push({
        target: `the ${name} notification channel`,
        record: "runtime",
        reason: `it answered for ${answer.key}, which was not due on it or was answered already`,
      });
      continue;
    }
    byKey.delete(answer.key);
    out.push({ cause, answer });
  }
  for (const cause of byKey.values())
    out.push({
      cause,
      answer: {
        key: cause.notice.key,
        outcome: "lost",
        place: null,
        detail: `the ${name} channel gave no answer for it`,
      },
    });
  return out;
}

const EXPIRED = Symbol("delivery expired");

/** The channel's answers for `batch`; a throw, which the port does not allow, is reported and answers every cause of the batch as lost. */
async function answersOf(
  channel: NotificationChannel<Cause>,
  batch: readonly Cause[],
  { report, timeLeftMs, deliveryTimeoutMs }: SendScope,
): Promise<Delivery[]> {
  try {
    const left = timeLeftMs();
    if (left !== null && left <= 0)
      // Nothing was attempted, so the causes wait: no failure is counted.
      return batch.map((c) => ({
        key: c.notice.key,
        outcome: "waits",
        place: null,
        detail: "the tick's time budget was already spent",
      }));
    const timeoutMs = Math.max(
      1,
      Math.min(left ?? deliveryTimeoutMs, deliveryTimeoutMs),
    );
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const expired = new Promise<typeof EXPIRED>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(EXPIRED);
        }, timeoutMs);
      });
      const delivery = channel.deliver(batch, {
        timeLeftMs,
        signal: controller.signal,
      });
      let deliveries = await Promise.race([delivery, expired]);
      let expiredNote: string | undefined;
      if (deliveries === EXPIRED) {
        // The channel stops before its next effect once aborted: wait for it
        // to quiesce before the batch is answered, so no write lands after
        // its outcome is recorded. The wait comes out of the tick's remaining
        // budget, never past it, and a receipt the channel returns within it
        // is kept.
        expiredNote = `delivery did not finish within ${timeoutMs}ms`;
        const graceMs = Math.max(
          0,
          Math.min(timeLeftMs() ?? deliveryTimeoutMs, deliveryTimeoutMs),
        );
        let grace: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          delivery.then(
            (late) => ({ late }),
            () => undefined,
          ),
          new Promise<undefined>((resolve) => {
            grace = setTimeout(() => resolve(undefined), graceMs);
          }),
        ]);
        clearTimeout(grace);
        if (settled === undefined)
          return lostAnswers(channel, batch, report, expiredNote);
        deliveries = settled.late;
      }
      if (!Array.isArray(deliveries))
        return lostAnswers(
          channel,
          batch,
          report,
          "returned malformed delivery answers",
        );
      const valid = deliveries.filter(validDelivery);
      if (valid.length !== deliveries.length)
        report.unplaced.push({
          target: `the ${channel.name} notification channel`,
          record: "runtime",
          reason:
            "it returned malformed delivery answers; valid answers were retained and missing causes count as lost",
        });
      if (expiredNote !== undefined)
        report.unplaced.push({
          target: `the ${channel.name} notification channel`,
          record: "runtime",
          reason: `${expiredNote}; the answers it settled with during cancellation were retained`,
        });
      return valid;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } catch (error) {
    return lostAnswers(channel, batch, report, failureText(error));
  }
}

function lostAnswers(
  channel: NotificationChannel<Cause>,
  batch: readonly Cause[],
  report: RepoReport,
  why: string,
): Delivery[] {
  report.unplaced.push({
    target: `the ${channel.name} notification channel`,
    record: "runtime",
    reason: `its delivery failed, and its batch counts as lost: ${why}`,
  });
  return batch.map((c) => ({
    key: c.notice.key,
    outcome: "lost",
    place: null,
    detail: `the ${channel.name} channel failed: ${why}`,
  }));
}

function validDelivery(value: unknown): value is Delivery {
  if (typeof value !== "object" || value === null) return false;
  const delivery = value as Partial<Delivery>;
  return (
    typeof delivery.key === "string" &&
    (delivery.outcome === "sent" ||
      delivery.outcome === "already" ||
      delivery.outcome === "lost" ||
      delivery.outcome === "waits") &&
    (typeof delivery.place === "string" || delivery.place === null) &&
    typeof delivery.detail === "string"
  );
}

/** One batch of the tick's notifications on one channel, sent, recorded and counted. */
async function deliverOn(
  channel: NotificationChannel<Cause>,
  batch: readonly Cause[],
  scope: SendScope,
): Promise<void> {
  if (batch.length === 0) return;
  const { report, settings } = scope;
  const name = channel.name;
  const outcomes = answered(
    name,
    batch,
    await answersOf(channel, batch, scope),
    report,
  );
  for (const { cause: c, answer: o } of outcomes) {
    if (o.outcome === "sent" || o.outcome === "already")
      recordSent(name, c, o.place ?? "", scope);
    report.notifications.push(
      outcomeFor(name, c, o.outcome, o.place, o.detail),
    );
  }
  if (settings.book != null) countDeliveries(name, settings.book, outcomes);
}

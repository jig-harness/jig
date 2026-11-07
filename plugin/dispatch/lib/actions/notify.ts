/**
 * `--apply` for notifications, where the machine file enables `notify`:
 * each cause the plan names (a park with decisions unanswered, a drive
 * stopped on what only a person settles, a failed follow-up, a stalled
 * pickup, a double claim, a session waiting) reaches a person through the
 * runtime's `notify`, and again on a cadence while it stands.
 *
 * - **Once per cause, then on a cadence.** A cause counts as sent, and its
 *   suppression record is written (the state database's `notices` table,
 *   keyed by the repository and the cause's key), only once the runtime's
 *   receipt shows the target's comment carrying its key; a cause whose key
 *   the comment already carries is recorded as sent without being sent
 *   again. A cause that still stands `dispatch.renotify_after` after it was
 *   last sent is sent again, marked as a repeat, unless the destination is
 *   still unread with it (`0s` sends each cause once). A drift or exhausted no-cause recovery is
 *   sent once for the life of its key. A suppression record is
 *   dropped when its cause leaves a tick that read every record whole (the
 *   park was answered, the drive moved on), so a cause that is settled is
 *   never repeated and new facts always notify.
 * - **One destination per repository.** Every cause goes to the workspace
 *   on `dispatch.notices_branch` when the repository names one, else to the
 *   repository's notices workspace (`NOTICES_BRANCH`), opened from the
 *   default branch and named as the dispatcher's (`NOTICES_NAME`); never to
 *   the workspace joined to the pull request or item, which a person
 *   watching many repositories does not visit. The message names that
 *   workspace, where the stage's handoff is. An explicitly named destination
 *   takes only an empty comment or an existing dispatcher notice. The automatic
 *   notices workspace also accepts its own kickoff comment or one whose agent
 *   has started (a kickoff prompt waits until its agent starts); a named
 *   workspace that is not open, or cannot take a comment, leaves the cause
 *   waiting, reported.
 * - **One comment per workspace.** The causes for one workspace in a tick
 *   are joined into one message; while the workspace is still unread from
 *   an earlier notification, the new causes are appended to its comment
 *   rather than replacing what a person has not read.
 * - **One event row per cause.** A cause's event row goes into the outcome
 *   log (`log.ts`) in the same transaction as its suppression record, timed
 *   at that record and keyed by the same facts; a cause about a stage this
 *   machine launched has its ended row instead.
 *
 * Once they are sent, the notices workspace is removed when its job is done
 * (`retire-notices.ts`); a workspace `notices_branch` names is a person's,
 * and is never removed.
 *
 * The answer to a park stays a comment on the pull request (`answer <key>:
 * …`), which the next tick reads as a re-armable ledger: nothing comes back
 * through the notification.
 */
import { noticeComment } from "../runtime/notice-comment.ts";
import { stateRoot } from "../../receipts.ts";
import {
  driveClass,
  insertRow,
  type LogRow,
  type OutcomeClass,
} from "../log.ts";
import { carries, holdsNotice, unobservedTarget } from "../notices.ts";
import {
  MAX_COMMENT,
  NOTICES_NAME,
  type RuntimeReceipt,
  type SessionsReport,
  type Workspace,
  withoutMarks,
} from "../runtime/port.ts";
import { inTransaction, stateDb } from "../state.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  Notice,
  NotifyCause,
  NotifyOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import { type ApplyState, openWithinBudget, timeLeftMs } from "./launch.ts";
import {
  intendComment,
  ownsComment,
  pruneComments,
  recordComment,
} from "./notices-content.ts";
import { retireNotices } from "./retire-notices.ts";

/** The branch of a repository's notices workspace. */
const NOTICES_BRANCH = "jig-dispatch-notices";

/** The comments the dispatcher's opens gave a workspace before its comments carried the dispatched mark. */
const OWN_COMMENT =
  /(driven|picked up) by jig dispatch$|^jig dispatch notices$/;

interface Suppression {
  repo: string;
  target: string;
  key: string;
  /** When it was first sent. */
  at: string;
  /** When it was last sent: `at`, or its latest repeat. */
  sentAt: string;
  workspace: string;
  /** Set for a cause notified once for the life of its key: the cause going away does not release it. */
  lasting: boolean;
}

/** The suppression records of `repo`, by key. */
function readSuppressions(
  repo: string,
  root: string,
): Map<string, Suppression> {
  const rows = stateDb(root)
    .query(
      "SELECT repo, key, target, workspace, at, sent_at, lasting FROM notices WHERE repo = ?",
    )
    .all(repo) as Array<
    Omit<Suppression, "lasting" | "sentAt"> & {
      lasting: number;
      sent_at: string | null;
    }
  >;
  return new Map(
    rows.map((r) => [
      r.key,
      {
        repo: r.repo,
        key: r.key,
        target: r.target,
        workspace: r.workspace,
        at: r.at,
        sentAt: r.sent_at ?? r.at,
        lasting: r.lasting === 1,
      },
    ]),
  );
}

/**
 * Write a cause's suppression record, and its event row with it in one
 * transaction; the record that is already there stands. A repeat moves the
 * record's last send and its workspace, and writes no event row: the cause's
 * row was written when it was first sent.
 */
function suppress(
  record: Omit<Suppression, "sentAt">,
  event: LogRow | null,
  root: string,
  repeat: boolean,
): void {
  const db = stateDb(root);
  if (repeat) {
    db.query(
      "UPDATE notices SET sent_at = ?, workspace = ? WHERE repo = ? AND key = ?",
    ).run(record.at, record.workspace, record.repo, record.key);
    return;
  }
  inTransaction(db, () => {
    const written = db
      .query(
        `INSERT INTO notices (repo, key, target, workspace, at, lasting)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (repo, key) DO NOTHING`,
      )
      .run(
        record.repo,
        record.key,
        record.target,
        record.workspace,
        record.at,
        record.lasting ? 1 : 0,
      );
    if (written.changes === 1 && event !== null) insertRow(db, event);
  });
}

/**
 * Whether the tick may write a workspace's comment: no kickoff prompt can be
 * waiting in it. Its dispatched marks are the dispatcher's own, and stay
 * when it writes.
 */
function takesComment(w: Workspace): boolean {
  const own = withoutMarks(w.comment);
  return (
    w.agents.length > 0 ||
    own === "" ||
    holdsNotice(own) ||
    OWN_COMMENT.test(own)
  );
}

/** A notification the plan names, with its cause and message; `repeat` once it is sent again after `renotify_after`. */
export type Cause = Action & {
  cause: NotifyCause;
  notice: Notice;
  repeat?: true;
};

function isCause(a: Action): a is Cause {
  return (
    a.stage === "notify" && a.cause !== undefined && a.notice !== undefined
  );
}

/** Whether a workspace is joined to a cause's target: the workspace a launch record names, the pull request, or the item. */
function joins(cause: Cause, w: Workspace): boolean {
  if (cause.workspace !== undefined) return w.path === cause.workspace;
  const pr = /^PR #(\d+)$/.exec(cause.target);
  return pr === null
    ? w.items.includes(cause.target)
    : w.prs.includes(Number(pr[1]));
}

/**
 * The cause with the workspaces joined to its target named at the end of
 * its message: where its stage ran and its handoff is, since the message
 * itself goes to the repository's one destination.
 */
function located(
  cause: Cause,
  workspaces: Workspace[],
  destination: Workspace,
): Cause {
  const joined = workspaces
    .filter((w) => w.path !== destination.path && joins(cause, w))
    .map((w) => w.path)
    .sort((a, b) => a.localeCompare(b));
  if (joined.length === 0) return cause;
  const named = `${joined.length === 1 ? "Its workspace" : "Its workspaces"}: ${joined.join(", ")}`;
  return {
    ...cause,
    notice: { ...cause.notice, text: `${cause.notice.text}\n${named}` },
  };
}

function hours(ms: number): string {
  return ms % 3_600_000 === 0
    ? `${ms / 3_600_000}h`
    : `${Math.round(ms / 60_000)}m`;
}

/** A cause sent again: its message says it still waits, and since when. */
function asRepeat(
  cause: Cause,
  record: Suppression,
  everyMs: number,
  nowMs: number,
): Cause {
  const [head = "", ...rest] = cause.notice.text.split("\n");
  const again = `Sent again: this still waits on a person as of ${new Date(nowMs).toISOString()}, first sent ${record.at} (dispatch.renotify_after ${hours(everyMs)}).`;
  return {
    ...cause,
    repeat: true,
    notice: { ...cause.notice, text: [head, again, ...rest].join("\n") },
  };
}

function outcomeFor(
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
  };
}

const NO_JOIN = { keys: null, branchPattern: "", pullRequests: [] } as const;

/** Why the destination workspace on `branch` must not be written; `null` when it takes the message. */
function noticesBlocked(w: Workspace, branch = NOTICES_BRANCH): string | null {
  return takesComment(w)
    ? null
    : `the workspace on ${branch} (${w.path}) holds a comment that is not the dispatcher's, which a notification would overwrite`;
}

/**
 * The repository's one destination: the workspace on `dispatch.notices_branch`
 * when the repository names one, which the tick never opens, else the
 * notices workspace.
 */
async function destination(
  state: ApplyState,
  repo: RepoTarget,
  sessions: { workspaces: Workspace[]; report: RepoReport },
  branch: string | null,
): Promise<Workspace | string> {
  const { workspaces, report } = sessions;
  if (branch === null) return noticesWorkspace(state, repo, workspaces, report);
  const found = workspaces.find((w) => w.branch === branch);
  if (found === undefined && branch === NOTICES_BRANCH)
    return noticesWorkspace(state, repo, workspaces, report);
  if (found === undefined)
    return `no workspace on ${branch}, the branch dispatch.notices_branch names, is open: open one there, or remove the setting to use the repository's notices workspace`;
  return withoutMarks(found.comment) === "" || holdsNotice(found.comment)
    ? found
    : `the workspace on ${branch} (${found.path}) holds a personal comment, which a notification would overwrite`;
}

/** Admit the whole runtime operation while keeping the receipt's reserved time. */
function noticeTime(state: ApplyState, calls: number): string | null {
  const left = timeLeftMs(state);
  return left !== null && left < calls * state.machine.runtimeTimeoutMs
    ? "the tick deadline has no room for the notification operation and its receipt; a later tick delivers this one"
    : null;
}

/** A post-open listing includes both repository and workspace reads, each under the runtime timeout. */
async function rereadNotices(
  state: ApplyState,
  repo: RepoTarget,
): Promise<SessionsReport> {
  const late = noticeTime(state, 2);
  if (late !== null)
    return { ok: false, source: state.runtime.name, reason: late };
  try {
    return await state.runtime.sessions(repo, NO_JOIN);
  } catch (error) {
    return {
      ok: false,
      source: state.runtime.name,
      reason: failureText(error),
    };
  }
}

/** The repository's notices workspace: the one on `NOTICES_BRANCH`, else opened now; its comment is read before it is adopted. */
async function noticesWorkspace(
  state: ApplyState,
  repo: RepoTarget,
  workspaces: Workspace[],
  report: RepoReport,
): Promise<Workspace | string> {
  const found = workspaces.find((w) => w.branch === NOTICES_BRANCH);
  if (found !== undefined) return noticesBlocked(found) ?? found;
  const opened = await openWithinBudget(state, repo, {
    notices: NOTICES_BRANCH,
    dispatched: { name: NOTICES_NAME, mark: NOTICES_NAME },
  });
  if ("waits" in opened) return opened.waits;
  if ("refused" in opened)
    return `the notices workspace could not be opened: ${opened.refused}`;
  if (opened.cleanupFailure !== undefined)
    report.unplaced.push({
      target: "the notices workspace",
      record: "runtime",
      reason: opened.cleanupFailure,
    });
  // Opening reattaches a workspace that already holds the branch: its comment is read again, not assumed empty.
  const again = await rereadNotices(state, repo);
  if (!again.ok)
    return `the notices workspace opened, and its comment could not be read: ${again.reason}`;
  const read = again.workspaces.find((w) => w.path === opened.workspace.path);
  if (read === undefined)
    return "the notices workspace opened and is not in the runtime's answer yet";
  workspaces.push(read);
  return noticesBlocked(read) ?? read;
}

/** The causes that fit one comment after the unread text, which is kept whole; one that does not fit waits until it is read, and a later one that fits still goes. */
export function fitting(
  workspace: Workspace,
  causes: Cause[],
  preserveRead = false,
): { send: Cause[]; later: Cause[] } {
  const send: Cause[] = [];
  const later: Cause[] = [];
  for (const c of causes) {
    const next = noticeComment(
      { comment: workspace.comment, unread: workspace.unread !== false },
      messageFor([...send, c]),
      preserveRead,
    );
    if (next !== null && next.length > MAX_COMMENT) {
      later.push(c);
      continue;
    }
    send.push(c);
  }
  return { send, later };
}

/** The message for a workspace: the causes' texts; the runtime appends them to a comment still unread. */
function messageFor(causes: Cause[]): string {
  return causes.map((c) => c.notice.text).join("\n\n");
}

/** `notify`'s answer; a call that throws is an answer lost. */
async function deliver(
  state: ApplyState,
  workspace: Workspace,
  message: string,
  dispatcherOnly: boolean,
  replaceReadComment?: string,
  prepareComment?: (
    before: string,
    projected: string,
    unread: boolean,
  ) => boolean,
): Promise<RuntimeReceipt> {
  try {
    return await state.runtime.notify(
      {
        id: workspace.id,
        path: workspace.path,
        branch: workspace.branch,
        dispatcherOnly,
        ...(prepareComment === undefined ? {} : { prepareComment }),
        ...(replaceReadComment === undefined ? {} : { replaceReadComment }),
      },
      message,
    );
  } catch (error) {
    return { ok: false, lost: true, detail: failureText(error) };
  }
}

/** Why the receipt does not show a cause arrived; `null` when it does. */
function notArrived(receipt: RuntimeReceipt, cause: Cause): string | null {
  if (!receipt.ok) return receipt.detail;
  if (
    cause.repeat === true &&
    (receipt.unread !== true || !receipt.comment?.includes(cause.notice.text))
  )
    return "the read-back does not confirm this repeat's text and unread mark";
  return carries(receipt.comment ?? "", cause.notice.key)
    ? null
    : "the comment read back does not carry it";
}

/**
 * The causes the workspace's comment already carries, recorded as sent
 * without sending them again, and the rest. A repeat goes again unless the
 * destination is still unread with it: a person who read it and did not act
 * is told again.
 */
function alreadyThere(
  workspace: Workspace,
  causes: Cause[],
  suppress: (cause: Cause, workspace: string) => void,
): { out: NotifyOutcome[]; fresh: Cause[] } {
  const already = causes.filter(
    (c) =>
      carries(workspace.comment, c.notice.key) &&
      (c.repeat !== true || workspace.unread !== false),
  );
  const out = already.map((c) => {
    suppress(c, workspace.path);
    return outcomeFor(
      c,
      "already",
      workspace.path,
      c.repeat === true
        ? "due again, and the workspace is still unread with it"
        : "the workspace's comment already carried it",
    );
  });
  return { out, fresh: causes.filter((c) => !already.includes(c)) };
}

/** How a sent cause went, by the receipt: sent (again, for a repeat) or lost. */
function delivered(
  receipt: RuntimeReceipt,
  cause: Cause,
  workspace: string,
): NotifyOutcome {
  const why = notArrived(receipt, cause);
  if (why !== null) return outcomeFor(cause, "lost", workspace, why);
  const detail = receipt.ok ? receipt.detail : "";
  return outcomeFor(
    cause,
    "sent",
    workspace,
    cause.repeat === true
      ? `sent again, the cause still standing: ${detail}`
      : detail,
  );
}

/** One workspace's causes, joined into one message and sent. */
async function sendTo(
  state: ApplyState,
  workspace: Workspace,
  causes: Cause[],
  suppress: (cause: Cause, workspace: string) => void,
  root: string,
  repo: string,
  dispatcherOnly: boolean,
): Promise<NotifyOutcome[]> {
  // Reconcile an interrupted delivery even when every cause is already present.
  const owned = ownsComment(workspace, root);
  const { out, fresh } = alreadyThere(workspace, causes, suppress);
  if (fresh.length === 0) return out;
  const late = noticeTime(state, 1);
  if (late !== null)
    return [...out, ...fresh.map((c) => outcomeFor(c, "waits", null, late))];
  const preserveRead = dispatcherOnly && !owned;
  const { send, later } = fitting(workspace, fresh, preserveRead);
  out.push(
    ...later.map((c) =>
      outcomeFor(
        c,
        "waits",
        null,
        "the comment is full: read unread notices or shorten personal additions so a later tick can deliver it",
      ),
    ),
  );
  if (send.length === 0) return out;
  const message = messageFor(send);
  const receipt = await deliver(
    state,
    workspace,
    message,
    dispatcherOnly,
    owned ? workspace.comment : undefined,
    (before, projected, unread) => {
      const known =
        ownsComment({ ...workspace, comment: before }, root) ||
        (!dispatcherOnly && !unread);
      if (known) intendComment(workspace, projected, root, repo);
      return known;
    },
  );
  if (
    receipt.ok &&
    receipt.ownedComment === true &&
    receipt.comment !== undefined
  )
    recordComment(workspace, receipt.comment, root, repo);
  for (const c of send) {
    const outcome = delivered(receipt, c, workspace.path);
    if (outcome.outcome === "sent") suppress(c, workspace.path);
    out.push(outcome);
  }
  return out;
}

/**
 * A suppression record and its event row that could not be written: the
 * next tick finds the cause's key in the target's comment and writes them
 * then. Reported so the tick fails and the receipt says what the dashboard
 * lacks.
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
 * Drop the suppression records of `repo` whose cause this tick no longer
 * names, when every record was read whole and the target is not one the
 * tick could not place: the facts that made the cause have changed. A
 * drift is notified once per launch and expectation, so its record stays.
 */
function prune(
  report: RepoReport,
  keys: ReadonlySet<string>,
  sent: Map<string, Suppression>,
  root: string,
): void {
  if (!report.records.every((r) => r.ok)) return;
  const gone = [...sent.values()].filter(
    (s) =>
      !keys.has(s.key) && !unobservedTarget(report, s.target) && !s.lasting,
  );
  if (gone.length === 0) return;
  const db = stateDb(root);
  const drop = db.query("DELETE FROM notices WHERE repo = ? AND key = ?");
  inTransaction(db, () => {
    for (const s of gone) drop.run(s.repo, s.key);
  });
}

/** The due causes at the repository's destination, each naming where its stage ran; `null`, every cause reported waiting, when it cannot be reached. */
async function atDestination(
  state: ApplyState,
  repo: RepoTarget,
  due: Cause[],
  sessions: { workspaces: Workspace[]; report: RepoReport },
  branch: string | null,
): Promise<{ workspace: Workspace; causes: Cause[] } | null> {
  // The listing before the destination is opened: the notices workspace is no cause's own.
  const listed = [...sessions.workspaces];
  const target = await destination(state, repo, sessions, branch);
  if (typeof target === "string") {
    for (const cause of due)
      sessions.report.notifications.push(
        outcomeFor(cause, "waits", null, target),
      );
    return null;
  }
  return {
    workspace: target,
    causes: due.map((c) => located(c, listed, target)),
  };
}

/** The stage a cause is about, for its event row. */
function stageOf(cause: Cause): string {
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
      const exit = cause.evidence.exit;
      return typeof exit === "number"
        ? driveClass(exit, null).class
        : "unknown";
    }
    default:
      return null;
  }
}

/** The event row for a cause timed at `at`. */
function eventRow(repo: string, cause: Cause, at: string): LogRow {
  return {
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

/** `--apply` for one repository's notifications, then its notices workspace. */
export async function applyNotices(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  settings: NoticeSettings,
): Promise<void> {
  const root = state.root ?? stateRoot();
  if (sessions.ok) pruneComments(repo.slug, sessions.workspaces, root);
  const causes = report.actions.filter(isCause);
  const written = await sendNotices(state, repo, report, sessions, {
    causes,
    root,
    settings,
  });
  const { lingerMs } = settings;
  if (!sessions.ok) return;
  const notices =
    sessions.workspaces.find((w) => w.branch === NOTICES_BRANCH) ?? null;
  await retireNotices(state, report, {
    repo: repo.slug,
    workspace: notices,
    takesComment: notices !== null && ownsComment(notices, root),
    written,
    causes: causes.map((c) => c.notice.key),
    records: [...readSuppressions(repo.slug, root).values()],
    lingerMs,
    nowMs: Date.now(),
    root,
  });
}

/** The tick's notifications, sent; the workspaces it wrote or opened. */
async function sendNotices(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  {
    causes,
    root,
    settings,
  }: { causes: Cause[]; root: string; settings: NoticeSettings },
): Promise<Set<string>> {
  const sent = readSuppressions(repo.slug, root);
  prune(report, new Set(causes.map((c) => c.notice.key)), sent, root);
  const nowMs = Date.now();
  const due: Cause[] = [];
  for (const c of causes) {
    const earlier = sent.get(c.notice.key);
    if (earlier === undefined) due.push(c);
    else if (dueAgain(earlier, settings.renotifyAfterMs, nowMs))
      due.push(asRepeat(c, earlier, settings.renotifyAfterMs, nowMs));
    else
      report.notifications.push(
        outcomeFor(
          c,
          "suppressed",
          earlier.workspace,
          earlier.sentAt === earlier.at
            ? `sent ${earlier.at}`
            : `sent ${earlier.at}, again ${earlier.sentAt}`,
        ),
      );
  }
  if (due.length === 0) return new Set();
  if (!sessions.ok) {
    for (const c of due)
      report.notifications.push(outcomeFor(c, "waits", null, sessions.reason));
    return new Set();
  }
  const suppressed = (c: Cause, workspace: string) => {
    const at = new Date().toISOString();
    try {
      suppress(
        {
          repo: repo.slug,
          target: c.target,
          key: c.notice.key,
          at,
          workspace,
          lasting:
            c.cause === "drifting" ||
            (c.cause === "stopped-unknown" && c.evidence.noCause === true),
        },
        // A cause about a stage this machine launched has its ended row instead.
        c.launched === true ? null : eventRow(repo.slug, c, at),
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
  };
  const group = await atDestination(
    state,
    repo,
    due,
    { workspaces: sessions.workspaces, report },
    settings.branch,
  );
  if (group === null) return new Set();
  report.notifications.push(
    ...(await sendTo(
      state,
      group.workspace,
      group.causes,
      suppressed,
      root,
      repo.slug,
      settings.branch !== null,
    )),
  );
  return new Set([group.workspace.path]);
}

/**
 * The `orca-card` notification channel (`chat/channel.ts`): a workspace's
 * comment and unread mark, which Orca's phone app shows, written through
 * the session runtime's `notify`.
 *
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
 * - **Sent on its read-back.** A cause counts as sent only once the
 *   runtime's receipt shows the comment carrying its key; a cause whose key
 *   the comment already carries is answered as already there. A repeat goes
 *   again unless the destination is still unread with it.
 *
 * Once they are sent, the notices workspace is removed when its job is done
 * (`actions/retire-notices.ts`); a workspace `notices_branch` names is a
 * person's, and is never removed.
 */
import type {
  Delivery,
  DeliveryOutcome,
  NotificationChannel,
} from "../../../chat/channel.ts";
import { stateRoot } from "../../receipts.ts";
import {
  type ApplyState,
  openWithinBudget,
  settleMs,
  timeLeftMs,
} from "../actions/launch.ts";
import {
  intendComment,
  ownsComment,
  pruneComments,
} from "../actions/notices-content.ts";
import { recordComment } from "../actions/notices-content.ts";
import { retireNotices } from "../actions/retire-notices.ts";
import { HOST_NOTICE } from "../failure-notices.ts";
import {
  ORCA_CARD,
  readHostSuppressions,
  readSuppressions,
  type Suppression,
} from "../notice-records.ts";
import { carries, holdsNotice } from "../notices.ts";
import { failureText } from "../text.ts";
import type { NoticeCause, RepoReport, RepoTarget } from "../types.ts";
import { noticeComment } from "./notice-comment.ts";
import {
  MAX_COMMENT,
  NOTICES_BRANCH,
  NOTICES_NAME,
  type RuntimeReceipt,
  type SessionsReport,
  type Workspace,
  withoutMarks,
} from "./port.ts";

type Cause = NoticeCause;

/** The comments the dispatcher's opens gave a workspace before its comments carried the dispatched mark. */
const OWN_COMMENT =
  /(driven|picked up) by jig dispatch$|^jig dispatch notices$/;

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

function answer(
  cause: Cause,
  outcome: DeliveryOutcome,
  place: string | null,
  detail: string,
): Delivery {
  return { key: cause.notice.key, outcome, place, detail };
}

const NO_JOIN = { keys: null, branchPattern: "", pullRequests: [] } as const;

/** Why the destination workspace on `branch` must not be written; `null` when it takes the message. */
function noticesBlocked(w: Workspace, branch = NOTICES_BRANCH): string | null {
  return takesComment(w)
    ? null
    : `the workspace on ${branch} (${w.path}) holds a comment that is not the dispatcher's, which a notification would overwrite`;
}

/** What the channel reads and writes for one repository in one tick. */
interface CardContext {
  state: ApplyState;
  repo: RepoTarget;
  report: RepoReport;
  workspaces: Workspace[];
  /** `dispatch.notices_branch`; `null` for the repository's notices workspace. */
  branch: string | null;
  root: string;
}

/**
 * The repository's one destination: the workspace on `dispatch.notices_branch`
 * when the repository names one, which the tick never opens, else the
 * notices workspace.
 */
async function destination(context: CardContext): Promise<Workspace | string> {
  const { workspaces, branch } = context;
  if (branch === null) return noticesWorkspace(context);
  const found = workspaces.find((w) => w.branch === branch);
  if (found === undefined && branch === NOTICES_BRANCH)
    return noticesWorkspace(context);
  if (found === undefined)
    return `no workspace on ${branch}, the branch dispatch.notices_branch names, is open: open one there, or remove the setting to use the repository's notices workspace`;
  return withoutMarks(found.comment) === "" || holdsNotice(found.comment)
    ? found
    : `the workspace on ${branch} (${found.path}) holds a personal comment, which a notification would overwrite`;
}

/** Admit the whole runtime operation while keeping the receipt's reserved time. */
function noticeTime(state: ApplyState, calls: number): string | null {
  const left = timeLeftMs(state);
  return left !== null && left < settleMs(state.machine.runtimeTimeoutMs, calls)
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
async function noticesWorkspace({
  state,
  repo,
  workspaces,
  report,
}: CardContext): Promise<Workspace | string> {
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
async function write(
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
 * The causes the workspace's comment already carries, answered as already
 * there without sending them again, and the rest. A repeat goes again
 * unless the destination is still unread with it: a person who read it and
 * did not act is told again.
 */
function alreadyThere(
  workspace: Workspace,
  causes: Cause[],
): { out: Delivery[]; fresh: Cause[] } {
  const already = causes.filter(
    (c) =>
      carries(workspace.comment, c.notice.key) &&
      (c.repeat !== true || workspace.unread !== false),
  );
  const out = already.map((c) =>
    answer(
      c,
      "already",
      workspace.path,
      c.repeat === true
        ? "due again, and the workspace is still unread with it"
        : "the workspace's comment already carried it",
    ),
  );
  return { out, fresh: causes.filter((c) => !already.includes(c)) };
}

/** How a sent cause went, by the receipt: sent (again, for a repeat) or lost. */
function delivered(
  receipt: RuntimeReceipt,
  cause: Cause,
  workspace: string,
): Delivery {
  const why = notArrived(receipt, cause);
  if (why !== null) return answer(cause, "lost", workspace, why);
  const detail = receipt.ok ? receipt.detail : "";
  return answer(
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
  { state, root, repo, branch }: CardContext,
  workspace: Workspace,
  causes: Cause[],
): Promise<Delivery[]> {
  const dispatcherOnly = branch !== null;
  // Reconcile an interrupted delivery even when every cause is already present.
  const owned = ownsComment(workspace, root);
  const { out, fresh } = alreadyThere(workspace, causes);
  if (fresh.length === 0) return out;
  const late = noticeTime(state, 1);
  if (late !== null)
    return [...out, ...fresh.map((c) => answer(c, "waits", null, late))];
  const preserveRead = dispatcherOnly && !owned;
  const { send, later } = fitting(workspace, fresh, preserveRead);
  out.push(
    ...later.map((c) =>
      answer(
        c,
        "waits",
        null,
        "the comment is full: read unread notices or shorten personal additions so a later tick can deliver it",
      ),
    ),
  );
  if (send.length === 0) return out;
  const message = messageFor(send);
  const receipt = await write(
    state,
    workspace,
    message,
    dispatcherOnly,
    owned ? workspace.comment : undefined,
    (before, projected, unread) => {
      const known =
        ownsComment({ ...workspace, comment: before }, root) ||
        (!dispatcherOnly && !unread);
      if (known) intendComment(workspace, projected, root, repo.slug);
      return known;
    },
  );
  if (
    receipt.ok &&
    receipt.ownedComment === true &&
    receipt.comment !== undefined
  )
    recordComment(workspace, receipt.comment, root, repo.slug);
  if (receipt.ok && receipt.comment !== undefined) {
    workspace.comment = receipt.comment;
    workspace.unread = receipt.unread ?? null;
  }
  for (const c of send) out.push(delivered(receipt, c, workspace.path));
  return out;
}

/** The `orca-card` channel of one repository in one tick, and the workspaces it wrote or opened. */
export interface OrcaCard extends NotificationChannel<Cause> {
  readonly written: ReadonlySet<string>;
}

/** The `orca-card` channel of one repository in one tick, over the workspaces the runtime listed. */
export function orcaCard(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  branch: string | null,
): OrcaCard {
  const root = state.root ?? stateRoot();
  const written = new Set<string>();
  return {
    name: ORCA_CARD,
    written,
    unreachable: () => (sessions.ok ? null : sessions.reason),
    async deliver(due) {
      if (!sessions.ok)
        return due.map((c) => answer(c, "waits", null, sessions.reason));
      const context = {
        state,
        repo,
        report,
        workspaces: sessions.workspaces,
        branch,
        root,
      };
      // The listing before the destination is opened: the notices workspace is no cause's own.
      const listed = [...sessions.workspaces];
      const target = await destination(context);
      if (typeof target === "string")
        return due.map((c) => answer(c, "waits", null, target));
      const out = await sendTo(
        context,
        target,
        due.map((c) => located(c, listed, target)),
      );
      written.add(target.path);
      return out;
    },
  };
}

/** Forget the comments recorded for workspaces the listing no longer holds, before the channel writes. */
export function openCard(
  repo: RepoTarget,
  sessions: SessionsReport,
  root: string,
): void {
  if (sessions.ok) pruneComments(repo.slug, sessions.workspaces, root);
}

/** The suppression records that keep an unread notices workspace: the repository's own and the host failures' at any repository, which can be told here. */
function retirementRecords(repo: string, root: string): Suppression[] {
  const records = readSuppressions(ORCA_CARD, repo, root);
  for (const [key, record] of readHostSuppressions(
    ORCA_CARD,
    HOST_NOTICE,
    root,
  ))
    if (!records.has(key)) records.set(key, record);
  return [...records.values()];
}

/** Remove the repository's notices workspace once its job is done (`actions/retire-notices.ts`). */
export async function retireCard(
  card: OrcaCard,
  state: ApplyState,
  report: RepoReport,
  sessions: SessionsReport,
  {
    repo,
    causes,
    lingerMs,
  }: { repo: string; causes: readonly string[]; lingerMs: number },
): Promise<void> {
  if (!sessions.ok) return;
  const root = state.root ?? stateRoot();
  const notices =
    sessions.workspaces.find((w) => w.branch === NOTICES_BRANCH) ?? null;
  await retireNotices(state, report, {
    repo,
    workspace: notices,
    takesComment: notices !== null && ownsComment(notices, root),
    written: card.written,
    causes,
    records: retirementRecords(repo, root),
    lingerMs,
    nowMs: Date.now(),
    root,
  });
}

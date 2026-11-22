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
 *   rather than replacing what a person has not read. A comment that is
 *   exactly what the dispatcher wrote gives up the entries whose causes are
 *   settled (the test that retires an unread notices workspace: no cause
 *   this tick names, no record that still stands) to make room; an entry
 *   whose cause stands is never dropped. Every comment keeps room for a
 *   summary entry (`notice-overflow.ts`): a cause that still finds no room
 *   waits, which is not a failed delivery, and the summary entry in the
 *   comment counts it and says where to read it until it goes in full.
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
  recordComment,
} from "../actions/notices-content.ts";
import { retireNotices } from "../actions/retire-notices.ts";
import { HOST_NOTICE } from "../failure-notices.ts";
import {
  ORCA_CARD,
  readHostSuppressions,
  readSuppressions,
  settledEntries,
  type Suppression,
} from "../notice-records.ts";
import { carries, holdsNotice } from "../notices.ts";
import { failureText } from "../text.ts";
import { currentMs } from "../../../shared/time.ts";
import type { NoticeCause, RepoReport, RepoTarget } from "../types.ts";
import { noticeComment } from "./notice-comment.ts";
import {
  COUNTED_IN_SUMMARY,
  NO_ROOM,
  overflowWrite,
  SUMMARY_ROOM,
  summaryKeys,
} from "./notice-overflow.ts";
import {
  MAX_COMMENT,
  NOTICES_BRANCH,
  NOTICES_NAME,
  type NotifyTarget,
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
  /** The keys that stand this tick: the causes named, and the host failures still standing. */
  standing: () => ReadonlySet<string>;
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

/**
 * The causes that fit one comment after the unread text, which is kept
 * whole but for its `settled` entries, with `SUMMARY_ROOM` left for the
 * summary of those that wait; one that does not fit waits until there is
 * room, and a later one that fits still goes.
 */
export function fitting(
  workspace: Workspace,
  causes: Cause[],
  preserveRead = false,
  settled: readonly string[] = [],
): { send: Cause[]; later: Cause[] } {
  const gone = new Set(settled);
  const send: Cause[] = [];
  const later: Cause[] = [];
  for (const c of causes) {
    const next = noticeComment(
      { comment: workspace.comment, unread: workspace.unread !== false },
      messageFor([...send, c]),
      preserveRead,
      gone,
    );
    if (next !== null && next.length > MAX_COMMENT - SUMMARY_ROOM) {
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
  signal: AbortSignal,
  policy: Pick<
    NotifyTarget,
    "dispatcherOnly" | "replaceReadComment" | "settled" | "prepareComment"
  >,
): Promise<RuntimeReceipt> {
  try {
    return await state.runtime.notify(
      {
        id: workspace.id,
        path: workspace.path,
        branch: workspace.branch,
        signal,
        ...policy,
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
  signal: AbortSignal,
): Delivery {
  const why = notArrived(receipt, cause);
  // A cancelled delivery that wrote nothing was never attempted: wait, no failure.
  if (why !== null && !receipt.ok && receipt.lost !== true && signal.aborted)
    return answer(cause, "waits", null, why);
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

const SPENT = "the delivery time was spent before the write";

/** What one workspace's write is allowed to replace, and how it reads the comment it finds. */
function writePolicy(
  workspace: Workspace,
  {
    root,
    slug,
    dispatcherOnly,
    owned,
    settled,
  }: {
    root: string;
    slug: string;
    dispatcherOnly: boolean;
    owned: boolean;
    settled: readonly string[];
  },
): Parameters<typeof write>[4] {
  return {
    dispatcherOnly,
    ...(owned ? { replaceReadComment: workspace.comment } : {}),
    ...(settled.length === 0
      ? {}
      : { settled: { comment: workspace.comment, keys: [...settled] } }),
    prepareComment: (before, projected, unread) => {
      const known =
        ownsComment({ ...workspace, comment: before }, root) ||
        (!dispatcherOnly && !unread);
      if (known) intendComment(workspace, projected, root, slug);
      return known;
    },
  };
}

/** What a write's receipt changes: whether a write may have happened, and the comment now on the workspace. */
function afterWrite(
  workspace: Workspace,
  receipt: RuntimeReceipt,
  root: string,
  slug: string,
  mayHaveWritten: () => void,
): void {
  // A refusal that wrote nothing is `lost: false`; only an answer that may have written counts.
  if (receipt.ok || receipt.lost === true) mayHaveWritten();
  if (!receipt.ok || receipt.comment === undefined) return;
  if (receipt.ownedComment === true)
    recordComment(workspace, receipt.comment, root, slug);
  workspace.comment = receipt.comment;
  workspace.unread = receipt.unread ?? null;
}

/** One workspace's causes, joined into one message and sent. */
async function sendTo(
  { state, root, repo, report, branch, standing }: CardContext,
  workspace: Workspace,
  causes: Cause[],
  signal: AbortSignal,
  mayHaveWritten: () => void,
): Promise<Delivery[]> {
  const dispatcherOnly = branch !== null;
  // Reconcile an interrupted delivery even when every cause is already present.
  const owned = ownsComment(workspace, root);
  const { out, fresh } = alreadyThere(workspace, causes);
  if (fresh.length === 0) return out;
  const late = noticeTime(state, 1);
  if (late !== null)
    return [...out, ...fresh.map((c) => answer(c, "waits", null, late))];
  if (signal.aborted)
    return [...out, ...fresh.map((c) => answer(c, "waits", null, SPENT))];
  const preserveRead = dispatcherOnly && !owned;
  // Only a comment known to be the dispatcher's alone gives up its settled
  // entries; its summary of the causes that waited is never a cause's.
  const settled = owned
    ? [
        ...new Set([
          ...settledEntries(
            workspace.comment,
            report,
            standing(),
            retirementRecords(repo.slug, root),
          ),
          ...summaryKeys(workspace.comment, repo.slug),
        ]),
      ]
    : [];
  const { send, later } = fitting(workspace, fresh, preserveRead, settled);
  const plan = overflowWrite(
    { comment: workspace.comment, unread: workspace.unread !== false },
    messageFor(send),
    later,
    { slug: repo.slug, preserveRead, settled },
  );
  const held = (counted: boolean) =>
    later.map((c) =>
      answer(c, "waits", null, counted ? COUNTED_IN_SUMMARY : NO_ROOM),
    );
  if (plan.message === "") return [...out, ...held(plan.summary !== null)];
  const receipt = await write(
    state,
    workspace,
    plan.message,
    signal,
    writePolicy(workspace, {
      root,
      slug: repo.slug,
      dispatcherOnly,
      owned,
      settled: plan.settled,
    }),
  );
  afterWrite(workspace, receipt, root, repo.slug, mayHaveWritten);
  // A write that failed is the destination's failure, not a want of room: the held causes take its answer.
  if (!receipt.ok)
    out.push(
      ...later.map((c) =>
        receipt.lost !== true && signal.aborted
          ? answer(c, "waits", null, receipt.detail)
          : answer(c, "lost", workspace.path, receipt.detail),
      ),
    );
  else
    out.push(
      ...held(
        plan.summary !== null && carries(receipt.comment ?? "", plan.summary),
      ),
    );
  for (const c of send) out.push(delivered(receipt, c, workspace.path, signal));
  return out;
}

/** The `orca-card` channel of one repository in one tick, and the workspaces it opened or wrote a comment to. */
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
  standing: () => ReadonlySet<string>,
): OrcaCard {
  const root = state.root ?? stateRoot();
  const written = new Set<string>();
  return {
    name: ORCA_CARD,
    written,
    unreachable: () => (sessions.ok ? null : sessions.reason),
    async deliver(due, time) {
      if (!sessions.ok)
        return due.map((c) => answer(c, "waits", null, sessions.reason));
      const context = {
        state,
        repo,
        report,
        workspaces: sessions.workspaces,
        branch,
        standing,
        root,
      };
      // The listing before the destination is opened: the notices workspace is no cause's own.
      const listed = [...sessions.workspaces];
      const target = await destination(context);
      if (typeof target === "string")
        return due.map((c) => answer(c, "waits", null, target));
      if (time.signal.aborted)
        return due.map((c) => answer(c, "waits", null, SPENT));
      const out = await sendTo(
        context,
        target,
        due.map((c) => located(c, listed, target)),
        time.signal,
        () => written.add(target.path),
      );
      // An opened workspace counts as written; a refusal that wrote nothing does not.
      if (!listed.some((w) => w.path === target.path)) written.add(target.path);
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
    nowMs: currentMs(),
    root,
  });
}

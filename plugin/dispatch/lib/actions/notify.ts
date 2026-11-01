/**
 * `--apply` for notifications, where the machine file enables `notify`:
 * each cause the plan names (a park with decisions unanswered, a drive
 * stopped on what only a person settles, a failed follow-up, a stalled
 * pickup, a double claim, a session waiting) reaches a person once, through
 * the runtime's `notify`.
 *
 * - **Once per cause.** A cause counts as sent, and its suppression record
 *   is written under `~/.local/state/jig/dispatch/notices/`, only once the
 *   runtime's receipt shows the target's comment carrying its key; a cause
 *   whose key the comment already carries is recorded as sent without being
 *   sent again. A suppression record is dropped when its cause leaves a
 *   tick that read every record whole (the park was answered, the drive
 *   moved on), so the same facts never notify twice and new facts always
 *   do.
 * - **The target.** The workspace joined to the target when it can take a
 *   comment: an agent has started in it, or its comment is empty or the
 *   dispatcher's own (a workspace's comment carries a kickoff prompt until
 *   its agent starts, and the tick never overwrites one). Otherwise the
 *   repository's notices workspace (`NOTICES_BRANCH`), opened once from the
 *   default branch, its comment naming what each message is about.
 * - **One comment per workspace.** The causes for one workspace in a tick
 *   are joined into one message; while the workspace is still unread from
 *   an earlier notification, the new causes are appended to its comment
 *   rather than replacing what a person has not read.
 *
 * The answer to a park stays a comment on the pull request (`answer <key>:
 * …`), which the next tick reads as a re-armable ledger: nothing comes back
 * through the notification.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { swallow } from "../../../shared/errors.ts";
import { isRecord } from "../../../shared/guards.ts";
import { publishOnce, stateRoot } from "../../receipts.ts";
import { carries, holdsNotice } from "../notices.ts";
import type {
  RuntimeReceipt,
  SessionsReport,
  Workspace,
} from "../runtime/port.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  Notice,
  NotifyCause,
  NotifyOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import { type ApplyState, openWithinBudget, outOfTime } from "./launch.ts";

/** The branch of a repository's notices workspace. */
const NOTICES_BRANCH = "jig-dispatch-notices";

/** The comments the dispatcher's own opens give a workspace. */
const OWN_COMMENT =
  /(driven|picked up) by jig dispatch$|^jig dispatch notices$/;

interface Suppression {
  repo: string;
  target: string;
  key: string;
  at: string;
  workspace: string;
}

function noticesRoot(root: string): string {
  return join(root, "notices");
}

function fileOf(repo: string, key: string, root: string): string {
  const digest = createHash("sha256")
    .update(`${repo}\n${key}`)
    .digest("hex")
    .slice(0, 32);
  return join(noticesRoot(root), `${digest}.json`);
}

/** The suppression records of `repo`, by key, with their files. */
function readSuppressions(
  repo: string,
  root: string,
): Map<string, Suppression & { file: string }> {
  const out = new Map<string, Suppression & { file: string }>();
  let names: string[];
  try {
    names = readdirSync(noticesRoot(root));
  } catch (error) {
    swallow(error, "no notification has been sent yet");
    return out;
  }
  for (const name of names.filter((n) => /^[a-f\d]{32}\.json$/.test(n))) {
    const file = join(noticesRoot(root), name);
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        isRecord(value) &&
        value.repo === repo &&
        typeof value.key === "string" &&
        typeof value.target === "string"
      )
        out.set(value.key, { ...(value as unknown as Suppression), file });
    } catch (error) {
      swallow(error, `${name} is not a suppression record`);
    }
  }
  return out;
}

function suppress(record: Suppression, root: string): void {
  mkdirSync(noticesRoot(root), { recursive: true, mode: 0o700 });
  publishOnce(
    fileOf(record.repo, record.key, root),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/** Whether the tick may write a workspace's comment: no kickoff prompt can be waiting in it. */
function takesComment(w: Workspace): boolean {
  return (
    w.agents.length > 0 ||
    w.comment.trim() === "" ||
    holdsNotice(w.comment) ||
    OWN_COMMENT.test(w.comment.trim())
  );
}

/** A notification the plan names, with its cause and message. */
export type Cause = Action & { cause: NotifyCause; notice: Notice };

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

/** The workspace joined to a cause's target that can take its message; `null` when none. */
function joinedTarget(cause: Cause, workspaces: Workspace[]): Workspace | null {
  const joined = workspaces.filter((w) => joins(cause, w) && takesComment(w));
  return (
    joined.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    )[0] ?? null
  );
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

/** Why a workspace on the notices branch must not be written; `null` when it takes the message. */
function noticesBlocked(w: Workspace): string | null {
  return takesComment(w)
    ? null
    : `the workspace on ${NOTICES_BRANCH} (${w.path}) holds a comment that is not the dispatcher's, which a notification would overwrite`;
}

/** The repository's notices workspace: the one on `NOTICES_BRANCH`, else opened now; its comment is read before it is adopted. */
async function noticesWorkspace(
  state: ApplyState,
  repo: RepoTarget,
  workspaces: Workspace[],
): Promise<Workspace | string> {
  const found = workspaces.find((w) => w.branch === NOTICES_BRANCH);
  if (found !== undefined) return noticesBlocked(found) ?? found;
  const opened = await openWithinBudget(state, repo, {
    notices: NOTICES_BRANCH,
  });
  if ("waits" in opened) return opened.waits;
  if ("refused" in opened)
    return `the notices workspace could not be opened: ${opened.refused}`;
  // Opening reattaches a workspace that already holds the branch: its comment is read again, not assumed empty.
  let again: SessionsReport;
  try {
    again = await state.runtime.sessions(repo, NO_JOIN);
  } catch (error) {
    return `the notices workspace opened, and its comment could not be read: ${failureText(error)}`;
  }
  if (!again.ok)
    return `the notices workspace opened, and its comment could not be read: ${again.reason}`;
  const read = again.workspaces.find((w) => w.path === opened.workspace.path);
  if (read === undefined)
    return "the notices workspace opened and is not in the runtime's answer yet";
  return noticesBlocked(read) ?? read;
}

/** The most characters one comment holds: it travels as one process argument, which a platform bounds. */
const MAX_COMMENT = 16_000;

/** The causes that fit one comment after the unread text, which is kept whole; one that does not fit waits until it is read, and a later one that fits still goes. */
export function fitting(
  workspace: Workspace,
  causes: Cause[],
): { send: Cause[]; later: Cause[] } {
  const unread = workspace.unread && holdsNotice(workspace.comment);
  let used = unread ? workspace.comment.length : 0;
  const send: Cause[] = [];
  const later: Cause[] = [];
  for (const c of causes) {
    const next = used + c.notice.text.length + 2;
    if ((unread || send.length > 0) && next > MAX_COMMENT) {
      later.push(c);
      continue;
    }
    send.push(c);
    used = next;
  }
  return { send, later };
}

/** The message for a workspace: its comment whole while it is still unread from an earlier notification, then the causes' texts. */
function messageFor(workspace: Workspace, causes: Cause[]): string {
  const texts = causes.map((c) => c.notice.text);
  if (!(workspace.unread && holdsNotice(workspace.comment)))
    return texts.join("\n\n");
  return [workspace.comment, ...texts].join("\n\n");
}

/** `notify`'s answer; a call that throws is an answer lost. */
async function deliver(
  state: ApplyState,
  workspace: Workspace,
  message: string,
): Promise<RuntimeReceipt> {
  try {
    return await state.runtime.notify(
      { id: workspace.id, path: workspace.path },
      message,
    );
  } catch (error) {
    return { ok: false, lost: true, detail: failureText(error) };
  }
}

/** Why the receipt does not show a cause arrived; `null` when it does. */
function notArrived(receipt: RuntimeReceipt, cause: Cause): string | null {
  if (!receipt.ok) return receipt.detail;
  return carries(receipt.comment ?? "", cause.notice.key)
    ? null
    : "the comment read back does not carry it";
}

/** One workspace's causes, joined into one message and sent. */
async function sendTo(
  state: ApplyState,
  workspace: Workspace,
  causes: Cause[],
  suppress: (cause: Cause, workspace: string) => void,
): Promise<NotifyOutcome[]> {
  const already = causes.filter((c) =>
    carries(workspace.comment, c.notice.key),
  );
  const fresh = causes.filter((c) => !already.includes(c));
  const out = already.map((c) => {
    suppress(c, workspace.path);
    return outcomeFor(
      c,
      "already",
      workspace.path,
      "the workspace's comment already carried it",
    );
  });
  if (fresh.length === 0) return out;
  const late = outOfTime(state);
  if (late !== null)
    return [...out, ...fresh.map((c) => outcomeFor(c, "waits", null, late))];
  const { send, later } = fitting(workspace, fresh);
  out.push(
    ...later.map((c) =>
      outcomeFor(
        c,
        "waits",
        null,
        "the comment is full: it goes in the next tick, once the workspace's unread notices are read",
      ),
    ),
  );
  if (send.length === 0) return out;
  const receipt = await deliver(state, workspace, messageFor(workspace, send));
  for (const c of send) {
    const why = notArrived(receipt, c);
    if (why === null) suppress(c, workspace.path);
    out.push(
      why === null
        ? outcomeFor(c, "sent", workspace.path, receipt.detail)
        : outcomeFor(c, "lost", workspace.path, why),
    );
  }
  return out;
}

/**
 * Drop the suppression records of `repo` whose cause this tick no longer
 * names, when every record was read whole and the target is not one the
 * tick could not place: the facts that made the cause have changed.
 */
function prune(
  report: RepoReport,
  keys: ReadonlySet<string>,
  sent: Map<string, Suppression & { file: string }>,
): void {
  if (!report.records.every((r) => r.ok)) return;
  const unplaced = new Set(report.unplaced.map((u) => u.target));
  for (const [key, s] of sent)
    if (!keys.has(key) && !unplaced.has(s.target))
      rmSync(s.file, { force: true });
}

/** The causes for each target workspace; a cause with none reachable is reported as waiting. */
async function groupByTarget(
  state: ApplyState,
  repo: RepoTarget,
  due: Cause[],
  workspaces: Workspace[],
  report: RepoReport,
): Promise<Map<string, { workspace: Workspace; causes: Cause[] }>> {
  const groups = new Map<string, { workspace: Workspace; causes: Cause[] }>();
  let notices: Workspace | string | null = null;
  for (const cause of due) {
    let target = joinedTarget(cause, workspaces);
    if (target === null) {
      notices ??= await noticesWorkspace(state, repo, workspaces);
      if (typeof notices === "string") {
        report.notifications.push(outcomeFor(cause, "waits", null, notices));
        continue;
      }
      target = notices;
    }
    const group = groups.get(target.path) ?? { workspace: target, causes: [] };
    group.causes.push(cause);
    groups.set(target.path, group);
  }
  return groups;
}

/** `--apply` for one repository's notifications. */
export async function applyNotices(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
): Promise<void> {
  const root = state.root ?? stateRoot();
  const causes = report.actions.filter(isCause);
  const sent = readSuppressions(repo.slug, root);
  prune(report, new Set(causes.map((c) => c.notice.key)), sent);
  const due = causes.filter((c) => !sent.has(c.notice.key));
  for (const c of causes) {
    const earlier = sent.get(c.notice.key);
    if (earlier !== undefined)
      report.notifications.push(
        outcomeFor(c, "suppressed", earlier.workspace, `sent ${earlier.at}`),
      );
  }
  if (due.length === 0) return;
  if (!sessions.ok) {
    for (const c of due)
      report.notifications.push(outcomeFor(c, "waits", null, sessions.reason));
    return;
  }
  const suppressed = (c: Cause, workspace: string) =>
    suppress(
      {
        repo: repo.slug,
        target: c.target,
        key: c.notice.key,
        at: new Date().toISOString(),
        workspace,
      },
      root,
    );
  const groups = await groupByTarget(
    state,
    repo,
    due,
    sessions.workspaces,
    report,
  );
  for (const { workspace, causes: mine } of groups.values())
    report.notifications.push(
      ...(await sendTo(state, workspace, mine, suppressed)),
    );
}

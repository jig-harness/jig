/**
 * The session runtime interface: everything the tick asks of the program
 * that runs agent sessions, independent of which program answers. Orca is
 * the first implementation (`orca.ts`); a second is a second implementation
 * of these methods, with nothing in the tick changed.
 *
 * An interactive launch runs only on a runtime that reports it can bind
 * the session to its account (`interactiveBinding`); a headless pass binds
 * itself through the wrapper, on any runtime. Every method runs
 * under a deadline, and an answer past it counts as lost.
 *
 * What the dispatcher starts is named by one convention, kept here, which
 * every runtime takes as strings (`dispatchedName`, `dispatchedMark`,
 * `tabTitle`): a workspace it creates is named for the stage and the key,
 * its comment carries the mark with the launch record's id, and the record
 * keeps the same mark. A skill may rename the workspace to what the work
 * became; the mark in its comment and on its record still says the
 * dispatcher started it.
 */
import type { IssueKeys } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { BusyHolder, RepoTarget } from "../types.ts";

/** An agent in a workspace, by the id the runtime reports it under. */
export interface AgentSession {
  id: string;
  /** The runtime's own word: `working`, `waiting`, `blocked`, `done`, … */
  state: string;
  agentType: string | null;
  /** When the agent entered its state, in milliseconds; `null` when the runtime does not say. */
  since: number | null;
}

/** One workspace of the repository, joined to items and pull requests. */
export interface Workspace {
  id: string;
  path: string;
  /** The checked-out branch, without `refs/heads/`; `""` when none. */
  branch: string;
  /** The items (issue keys) it is joined to. */
  items: string[];
  /** The pull requests it is joined to. */
  prs: number[];
  agents: AgentSession[];
  /**
   * Terminals the runtime cannot tell an agent's state in: a workspace
   * joined to a target with any is an unknown, never "no session".
   */
  unverifiableTerminals: number;
  comment: string;
  /** Null when the runtime did not report a boolean unread mark. */
  unread: boolean | null;
  /** The name the runtime shows for the workspace now; `""` when it reports none. */
  name: string;
}

/** What the join reads a workspace against. */
export interface JoinTargets {
  /** The tracker's key shape; `null` joins no item by its branch. */
  keys: IssueKeys | null;
  /** `pull_requests.branch_name`, the pattern an item's branch was made from. */
  branchPattern: string;
  /** Each open pull request's head branch, which names it. */
  pullRequests: ReadonlyArray<{ number: number; head: string }>;
}

export type SessionsReport =
  | { ok: true; source: string; workspaces: Workspace[] }
  | { ok: false; source: string; reason: string };

/** The states in which an agent holds its stage. */
/** The most characters one comment holds: it travels as one process argument, which a platform bounds. */
export const MAX_COMMENT = 16_000;

export const RUNNING_STATES: ReadonlySet<string> = new Set([
  "working",
  "waiting",
  "blocked",
]);

/** The running states in which an agent waits on someone: a question, a permission prompt. */
export const WAITING_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "blocked",
]);

/** A runtime's answer to a call that starts or sends something. */
export interface RuntimeReceipt {
  ok: boolean;
  detail: string;
  /** The workspace opened, but closing its initial terminal needs a manual retry. */
  cleanupFailure?: string;
  /** The agent's id, for a launch that started one. */
  agentId?: string;
  /** For `openWorkspace`: the workspace opened or reused. */
  workspace?: { id: string; path: string };
  /** The call ran past its deadline: its answer is lost, not a refusal. */
  lost?: boolean;
  /** For `retire`: a safety check found work or identity it cannot authorize removing. */
  refused?: boolean;
  /** For `openWorkspace`: the open was refused because a checkout the runtime does not list holds the branch and is in use. */
  busyHolder?: BusyHolder;
  /** For `notify`: the target's comment as the runtime reads it back after the write. */
  comment?: string;
  /** For `notify`: the unread mark read back with the comment. */
  unread?: boolean;
  /** For `notify`: the confirmed projection was persisted as dispatcher-only under the lock. */
  ownedComment?: boolean;
}

/** Notification identity and the comment policy rechecked under the write lock. */
export interface NotifyTarget {
  id: string;
  path: string;
  branch?: string;
  dispatcherOnly?: boolean;
  /** Exact dispatcher-owned read comment that may be replaced; rechecked under the lock. */
  replaceReadComment?: string;
  /** Persist the actual locked projection before writing; return whether it is dispatcher-only. */
  prepareComment?: (
    before: string,
    projected: string,
    unread: boolean,
  ) => boolean;
}

/**
 * What `launch` starts. `title` names its terminal tab (`tabTitle`), and
 * `mark` (`dispatchedMark`) is added to the workspace's comment before the
 * session starts, once, keeping what the comment already holds.
 */
export type LaunchStage =
  /** A headless pass: the wrapper (`run.ts`) under its launch record, in a terminal titled `title`. */
  | { kind: "headless"; title: string; mark: string; record: string }
  /**
   * An interactive session (a pickup's `do-item`, as an earlier release
   * recorded one):
   * `skill` on `target`, with the route's model and effort, under its
   * launch record. Its receipt names the agent by the id `sessions` reports
   * it under.
   */
  | {
      kind: "interactive";
      title: string;
      mark: string;
      record: string;
      skill: string;
      target: string;
      model: string | null;
      effort: string | null;
    };

/** An item a workspace is opened for, with what links its issue. */
export interface ItemTarget {
  /** The item's key: `#12`, `ENG-4`. */
  item: string;
  /** The branch the workspace opens, named by the repository's branch rule. */
  branch: string;
  /** The tracker adapter's name (`issue_tracker.adapter`): `github`, `linear`, `jira`. */
  tracker: string;
  dispatched: Dispatched;
}

/** A pull request a workspace is opened for: its head branch. */
export interface PullRequestTarget {
  pr: number;
  head: string;
  /** A merged PR follow-up may recreate a deleted branch from the base. */
  purpose?: "followup";
  dispatched: Dispatched;
}

/**
 * The workspace a repository's notifications go to when their target has
 * no workspace of its own that can take one: a branch of the default
 * branch, into which the dispatcher never launches an agent.
 */
export interface NoticesTarget {
  notices: string;
  dispatched: Dispatched;
}

/** Whether a runtime can start an interactive session billed to a chosen account. */
export type Binding = { ok: true } | { ok: false; reason: string };

/** A runtime's answer to which workspaces and sessions one repository has. */
export type SessionsReader = (
  repo: RepoTarget,
  join: JoinTargets,
) => Promise<SessionsReport>;

export interface SessionRuntime {
  readonly name: string;
  /**
   * Whether an interactive launch binds its session to the account it is
   * billed to, whatever account the host has active. A session whose launch
   * cannot bind its account is never started interactively; a pickup runs
   * as a headless pass.
   */
  readonly interactiveBinding: Binding;
  /**
   * The workspaces of `repo` with their agents, joined to items and pull
   * requests; `ok: false` when the answer cannot be trusted whole (a host
   * not covered, a page cut short), so nothing is read as "no session".
   */
  sessions(repo: RepoTarget, join: JoinTargets): Promise<SessionsReport>;
  /**
   * A reader of `sessions` for one tick's observe phases: what the runtime
   * lists host-wide is read at most once for the reader's life, and each
   * repository is answered from it as `sessions` would answer it, a failed
   * listing failing each repository's answer alike. Absent, each read is
   * `sessions`'. A read just before a launch never goes through it.
   */
  sessionsOnce?(): SessionsReader;
  /**
   * A workspace for an item (a new branch, its issue linked), a pull request
   * (its head) or the repository's notifications, reused when one exists. A
   * workspace it creates is named `target.dispatched.name`, with the mark as
   * its comment; one it reuses keeps its name and its comment.
   */
  openWorkspace(
    repo: RepoTarget,
    target: ItemTarget | PullRequestTarget | NoticesTarget,
  ): Promise<RuntimeReceipt>;
  /**
   * A session in the workspace that runs the stage, billed to `account`.
   * `key` is the launch record's token: a second call with a key already
   * launched starts no second session (for a session run through the
   * wrapper, its claim on its record keeps that promise).
   */
  launch(
    workspace: { id: string; path: string },
    stage: LaunchStage,
    account: string,
    key: string,
    sessionId?: string,
  ): Promise<RuntimeReceipt>;
  /**
   * A message that reaches a person through the workspace `target`: in
   * Orca, `message` appended to the workspace's comment while that is still
   * unread (read afresh under the comment lock, never from an earlier
   * listing), else set as the comment, and the workspace marked unread,
   * which Orca's phone app shows. The dispatched marks the comment held stay
   * in it (`keepMarks`). Its receipt carries the target's comment as the
   * runtime reads it back after the write, together with the unread mark.
   * A target's branch and dispatcher-only comment policy are rechecked
   * under the same lock as the write.
   */
  notify(target: NotifyTarget, message: string): Promise<RuntimeReceipt>;
  /**
   * One of the closed set of nudges (`NUDGES`), sent with Enter to the
   * agent the runtime reports under `session`. The adapter re-reads, in the
   * same call and just before it types, that the agent still waits, that
   * its screen shows the agent's input prompt with an empty input line and
   * no menu or question, and that no person is attached where the runtime
   * reports attachment. Its receipt: `ok` when the text was delivered; `ok:
   * false` with `lost` when a send was attempted and its answer is lost;
   * `ok: false` without `lost` when a check failed or could not be read,
   * so nothing was sent.
   */
  steer(session: string, nudge: Nudge): Promise<RuntimeReceipt>;
  /**
   * Remove the repository's notices workspace, its terminals and its branch,
   * once the runtime reads it again just before, under the comment lock
   * `notify` holds, with the comment and the unread mark the tick decided
   * on: a message written or read since stops it. Its receipt: `ok` when it
   * is gone; `ok: false` with `lost` when the removal's answer is lost;
   * `ok: false` without `lost` when the re-read differs or a call refused,
   * so nothing was removed.
   */
  retire(
    workspace: { id: string; path: string },
    expected: { comment: string; unread: boolean; branch?: string },
    timeoutMs?: number,
  ): Promise<RuntimeReceipt>;
}

/**
 * The closed set of nudges, with the text each sends. It has one entry:
 * **continue**, the prompt a person types by hand after a usage limit
 * reopens. A nudge joins only when the outcome log shows a mechanical cause
 * that recurs, with a target the tick can identify and a screen state it
 * can check; anything else a session needs goes to a person.
 */
export const NUDGES = {
  continue: "Your usage limit has reset. Continue",
} as const;
export type Nudge = keyof typeof NUDGES;

/**
 * The convention that names what the dispatcher starts, one place for every
 * runtime. A name reads on a board at a glance and survives a prefix search:
 * the mark, the stage, the key (`⚙ dispatched · rearm #456`). A comment
 * carries the same name and the launch record's id, one line per stage and
 * key (`⚙ dispatched · rearm #456 · launch <id>`). A terminal tab names the
 * dispatcher, the stage and the key (`jig dispatch · rearm #456`).
 */
const DISPATCHED = "⚙ dispatched";

const SEPARATOR = " · ";
const LAUNCH = " · launch ";

/** A stage the dispatcher starts something for: a launch record's action. */
export type NamedStage =
  | "pickup"
  | "rearm"
  | "takeover"
  | "followup"
  | "steward";

/** The name a workspace the dispatcher creates carries: the mark, the stage and the key. */
function dispatchedName(stage: NamedStage, key: string): string {
  return `${DISPATCHED}${SEPARATOR}${stage} ${key}`;
}

/** The line a workspace's comment and the launch record carry: the name and the launch record's id. */
export function dispatchedMark(
  stage: NamedStage,
  key: string,
  launchId: string,
): string {
  return `${dispatchedName(stage, key)}${LAUNCH}${launchId}`;
}

/** The title of the terminal tab a launch opens. */
export function tabTitle(stage: NamedStage, key: string): string {
  return `jig dispatch${SEPARATOR}${stage} ${key}`;
}

/** The name, and the comment's mark, of the repository's notices workspace, which no launch record names. */
export const NOTICES_NAME = `${DISPATCHED}${SEPARATOR}notices`;
/** The default branch of a repository's notices workspace. */
export const NOTICES_BRANCH = "jig-dispatch-notices";

/** What a workspace the dispatcher opens is named and marked with. */
export interface Dispatched {
  name: string;
  mark: string;
}

/** The name and the mark of a launch's workspace. */
export function dispatched(
  stage: NamedStage,
  key: string,
  launchId: string,
): Dispatched {
  return {
    name: dispatchedName(stage, key),
    mark: dispatchedMark(stage, key, launchId),
  };
}

/** One mark line of a comment: the name it carries and the launch record it names (`null` for the notices workspace's). */
export interface MarkLine {
  line: string;
  name: string;
  launch: string | null;
}

/** A launch's mark line: a stage the dispatcher names, a key without spaces and a launch record's id. */
const MARK_LINE = new RegExp(
  `^(${DISPATCHED}${SEPARATOR}(?:pickup|rearm|takeover|followup|steward) \\S+)${LAUNCH}(\\d{8}T\\d{6}Z-[a-f\\d]{8})$`,
);

/**
 * The mark lines of a comment, in order: the notices workspace's name and the
 * exact shape of a launch's mark. Any other line, whatever it begins with,
 * is the person's text.
 */
export function marksIn(comment: string): MarkLine[] {
  const marks: MarkLine[] = [];
  for (const raw of comment.split("\n")) {
    const line = raw.trim();
    if (line === NOTICES_NAME) {
      marks.push({ line, name: line, launch: null });
      continue;
    }
    const found = MARK_LINE.exec(line);
    if (found !== null)
      marks.push({
        line,
        name: found[1] as string,
        launch: found[2] as string,
      });
  }
  return marks;
}

/** A comment's lines other than those in `drop`, trimmed at the end. */
function linesBut(comment: string, drop: ReadonlySet<string>): string {
  return comment
    .split("\n")
    .filter((l) => !drop.has(l.trim()))
    .join("\n")
    .trimEnd();
}

/** The comment without its mark lines, trimmed. */
export function withoutMarks(comment: string): string {
  return linesBut(comment, new Set(marksIn(comment).map((m) => m.line))).trim();
}

/**
 * The comment with `mark` added on a line of its own, keeping what it
 * holds: an earlier mark of the same stage and key gives way to it, so the
 * comment names the latest launch once and holds one mark per stage and key.
 * `null` when the comment already carries the mark.
 */
export function withMark(comment: string, mark: string): string | null {
  const [added] = marksIn(mark);
  if (added === undefined) return null;
  const marks = marksIn(comment);
  if (marks.some((m) => m.line === added.line)) return null;
  const kept = linesBut(
    comment,
    new Set(marks.filter((m) => m.name === added.name).map((m) => m.line)),
  );
  return kept === "" ? added.line : `${kept}\n${added.line}`;
}

/**
 * `message` with the mark lines `previous` holds put first, so a rewrite of a
 * comment keeps them. `previous` is the comment as it was just read, so its
 * mark for a stage and key wins over a different launch's mark for the same
 * stage and key that `message` carries from an older snapshot.
 */
export function keepMarks(previous: string, message: string): string {
  const current = new Map<string, string>();
  for (const m of marksIn(previous)) current.set(m.name, m.line);
  if (current.size === 0) return message;
  const stale = new Set(
    marksIn(message)
      .filter((m) => current.has(m.name))
      .map((m) => m.line),
  );
  return `${[...current.values()].join("\n")}\n\n${linesBut(message, stale).trim()}`;
}

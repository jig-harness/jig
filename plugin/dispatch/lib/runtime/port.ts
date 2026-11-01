/**
 * The session runtime interface: everything the tick asks of the program
 * that runs agent sessions, independent of which program answers. Orca is
 * the first implementation (`orca.ts`); a second is a second implementation
 * of these methods, with nothing in the tick changed.
 *
 * `sessions`, `openWorkspace` and `launch` are built; an interactive
 * launch runs only on a runtime that reports it can bind the session to
 * its account (`interactiveBinding`). `notify` and `steer` are declared
 * with their contracts and refuse until the build step that needs them
 * implements them. Every method runs under a deadline, and an answer past
 * it counts as lost.
 */
import type { IssueKeys } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { RepoTarget } from "../types.ts";

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
  unread: boolean;
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
  /** The agent's id, for a launch that started one. */
  agentId?: string;
  /** For `openWorkspace`: the workspace opened or reused. */
  workspace?: { id: string; path: string };
  /** The call ran past its deadline: its answer is lost, not a refusal. */
  lost?: boolean;
}

/** What `launch` starts. */
export type LaunchStage =
  /** A headless pass: the wrapper (`run.ts`) under its launch record, in a terminal titled `title`. */
  | { kind: "headless"; title: string; record: string }
  /**
   * An interactive session (a pickup's `do-item`): `skill` on `target`, with
   * the route's model and effort, under its launch record. Its receipt names
   * the agent by the id `sessions` reports it under.
   */
  | {
      kind: "interactive";
      title: string;
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
}

/** Whether a runtime can start an interactive session billed to a chosen account. */
export type Binding = { ok: true } | { ok: false; reason: string };

export interface SessionRuntime {
  readonly name: string;
  /**
   * Whether an interactive launch binds its session to the account it is
   * billed to, whatever account the host has active. A session whose launch
   * cannot bind its account is never started: its pickups are reported.
   */
  readonly interactiveBinding: Binding;
  /**
   * The workspaces of `repo` with their agents, joined to items and pull
   * requests; `ok: false` when the answer cannot be trusted whole (a host
   * not covered, a page cut short), so nothing is read as "no session".
   */
  sessions(repo: RepoTarget, join: JoinTargets): Promise<SessionsReport>;
  /** A workspace for an item (a new branch, its issue linked) or a pull request (its head), reused when one exists. */
  openWorkspace(
    repo: RepoTarget,
    target: ItemTarget | { pr: number; head: string },
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
  /** A message that reaches a person; its receipt carries the target's comment as written. */
  notify(target: string, message: string): Promise<RuntimeReceipt>;
  /** One of the closed set of nudges, sent to a session the runtime reports waiting. */
  steer(session: string, nudge: string): Promise<RuntimeReceipt>;
}

/** A method a later build step implements. */
export function notYet(method: string, step: string): Promise<never> {
  return Promise.reject(
    new Error(`the session runtime's ${method} is not built yet (${step})`),
  );
}

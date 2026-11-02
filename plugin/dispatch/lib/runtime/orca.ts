/**
 * The session runtime on Orca. `sessions` reads `orca repo list --json` to
 * find the Orca repository a checkout is, and `orca worktree ps --json` for
 * its workspaces and their agents. A workspace is joined to a pull request
 * by the pull request Orca links to it or by its branch being the pull
 * request's head, and to an item by the issue Orca links to it or by its
 * branch carrying the item's key in the repository's branch form.
 *
 * Orca's command is the shared resolver's (`ORCA_CLI_COMMAND`, else the
 * command in `ORCA_CLI_BIN_DIR`), else `orca` on `PATH`.
 *
 * Orca cannot yet start an interactive session billed to a chosen account
 * (`ORCA_BINDING`): `orca agent launch` starts its agent on the account the
 * host has active, and takes no account or environment of its own.
 *
 * `notify` writes the workspace's comment and marks it unread (`orca
 * worktree set --comment … --unread`), then reads the comment back
 * (`orca worktree show`), which is the receipt the tick checks for each
 * message's key (`orca-notify.ts`).
 *
 * `steer` finds the agent's terminal by its id (`<tabId>:<leafId>`, as
 * `orca terminal list` names each terminal's tab and pane), re-reads the
 * agent's state, the workspace a person has open and the rendered screen,
 * and types the nudge with `orca terminal send --enter` (`orca-steer.ts`).
 */
import { realpathSync } from "node:fs";
import { orcaCommand, orcaFailure, orcaResult } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import { keyFromBranch } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { RepoTarget } from "../types.ts";
import { orcaLaunch } from "./orca-launch.ts";
import { orcaNotify } from "./orca-notify.ts";
import {
  openItemWorkspace,
  openNoticesWorkspace,
  openPullRequestWorkspace,
} from "./orca-open.ts";
import { orcaSteer } from "./orca-steer.ts";
import {
  type AgentSession,
  type Binding,
  type JoinTargets,
  NUDGES,
  type SessionRuntime,
  type SessionsReport,
  type Workspace,
} from "./port.ts";

/**
 * Whether Orca binds an interactive session to its account. `orca agent
 * launch` has no account selection for Claude Code (`orca account select`
 * covers OpenCode and Devin only), and Orca starts the agent with the
 * configuration directory of the account the host has active, which a
 * person can switch at any moment. The wrapper in a terminal tab binds the
 * session through the account's directory, as it does a headless pass, but
 * that Orca reports such a session as an agent, under the id its launch
 * receipt names, is not shown yet. Until it is, pickups are reported and
 * none is started.
 */
const ORCA_BINDING: Binding = {
  ok: false,
  reason:
    "an Orca agent launch cannot bind its session to a chosen account yet (it runs on the host's active account), so pickups are reported and none is started",
};

/** Seconds one Orca call may take: `runtime_timeout`'s default. */
const ORCA_TIMEOUT_SEC = 60;

/** The most rows one listing asks for; a cut page is an unknown. */
const ROW_LIMIT = 2000;

async function orca(
  args: string[],
  timeoutSec = ORCA_TIMEOUT_SEC,
): Promise<Record<string, unknown> | string> {
  const done = await run(
    [orcaCommand(process.env) ?? "orca", ...args, "--json"],
    { timeoutSec, stderr: "pipe" },
  );
  return (
    orcaResult(done) ?? `orca ${args.join(" ")} failed ${orcaFailure(done)}`
  );
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The Orca repository ids that are this checkout, by path or by remote; null
 * when a matching repository has no string id, which leaves its workspaces
 * unattributable.
 */
function repoIds(
  listing: Record<string, unknown>,
  repo: RepoTarget,
): string[] | null {
  const repos = Array.isArray(listing.repos) ? listing.repos : [];
  const path = real(repo.path);
  const remote = `github.com/${repo.slug}`.toLowerCase();
  const matched = repos.filter(isRecord).filter((r) => {
    const identity = isRecord(r.gitRemoteIdentity) ? r.gitRemoteIdentity : {};
    return (
      (typeof r.path === "string" && real(r.path) === path) ||
      (typeof identity.canonicalKey === "string" &&
        identity.canonicalKey.toLowerCase() === remote)
    );
  });
  const ids: string[] = [];
  for (const r of matched) {
    if (typeof r.id !== "string") return null;
    ids.push(r.id);
  }
  return ids;
}

/** A number or issue key out of one of Orca's link shapes. */
function linkValue(link: unknown): string | number | null {
  if (typeof link === "number" || typeof link === "string") return link;
  if (!isRecord(link)) return null;
  for (const field of ["identifier", "key", "number", "id"]) {
    const v = link[field];
    if (typeof v === "number" || (typeof v === "string" && v !== "")) return v;
  }
  return null;
}

function itemKey(value: string | number, join: JoinTargets): string | null {
  const raw = typeof value === "number" ? String(value) : value;
  return join.keys?.normalize(raw) ?? null;
}

/** What Orca's links on a workspace name: its pull request and its issues. */
function linked(row: Record<string, unknown>, join: JoinTargets) {
  const prs: number[] = [];
  const items: string[] = [];
  const add = (type: unknown, value: string | number | null) => {
    if (value === null) return;
    if (type === "pr") {
      if (typeof value === "number") prs.push(value);
      return;
    }
    const key = itemKey(value, join);
    if (key !== null) items.push(key);
  };
  add("pr", linkValue(row.linkedPR));
  add("issue", linkValue(row.linkedIssue));
  add("issue", linkValue(row.linkedLinearIssue));
  for (const item of Array.isArray(row.linkedItems) ? row.linkedItems : [])
    if (isRecord(item) && (item.type === "pr" || item.type === "issue"))
      add(item.type, linkValue(item));
  return { prs, items };
}

/** What a branch names: the pull request whose head it is, the item whose key it carries. */
function byBranch(branch: string, join: JoinTargets) {
  if (branch === "") return { prs: [], items: [] };
  const key =
    join.keys === null
      ? null
      : keyFromBranch(branch, join.keys, join.branchPattern);
  return {
    prs: join.pullRequests
      .filter((pr) => pr.head === branch)
      .map((pr) => pr.number),
    items: key === null ? [] : [key],
  };
}

function joins(
  row: Record<string, unknown>,
  branch: string,
  join: JoinTargets,
) {
  const links = linked(row, join);
  const named = byBranch(branch, join);
  return {
    prs: [...new Set([...links.prs, ...named.prs])].sort((a, b) => a - b),
    items: [...new Set([...links.items, ...named.items])].sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

/** The agents of a row; `null` when the row does not carry a readable list, an agent without a state (or with a blank one) included. */
function agents(row: Record<string, unknown>): AgentSession[] | null {
  if (
    !Array.isArray(row.agents) ||
    !row.agents.every(
      (a) =>
        isRecord(a) && typeof a.state === "string" && a.state.trim() !== "",
    )
  )
    return null;
  return row.agents.map((a) => ({
    id: typeof a.paneKey === "string" ? a.paneKey : "",
    state: String(a.state),
    agentType: typeof a.agentType === "string" ? a.agentType : null,
    since:
      typeof a.stateStartedAt === "number" && Number.isFinite(a.stateStartedAt)
        ? a.stateStartedAt
        : null,
  }));
}

/** Why the listing's coverage metadata is unusable; `null` when it is whole. */
function hostGap(ps: Record<string, unknown>): string | null {
  const scope = ps.hostScope;
  if (!isRecord(scope) || !Array.isArray(scope.omittedHostIds))
    return "orca worktree ps does not say which hosts it covers";
  return scope.omittedHostIds.length > 0
    ? `orca worktree ps does not cover host(s) ${scope.omittedHostIds.join(", ")}`
    : null;
}

/** Why a listing cannot be read as whole; `null` when it can. */
function partial(ps: Record<string, unknown>): string | null {
  if (!Array.isArray(ps.worktrees))
    return "orca worktree ps did not return a worktrees list";
  if (typeof ps.truncated !== "boolean")
    return "orca worktree ps does not say whether it cut its page short";
  if (ps.truncated)
    return `orca worktree ps cut its page short (${String(ps.totalCount)} rows)`;
  return hostGap(ps);
}

/** Terminals the runtime cannot report; an unreadable row counts as one. */
function unverifiable(
  row: Record<string, unknown>,
  listed: AgentSession[] | null,
): number {
  const count = terminalCount(row);
  return listed === null || count === null ? 1 + (count ?? 0) : count;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function branchOf(row: Record<string, unknown>): string {
  return typeof row.branch === "string"
    ? row.branch.replace(/^refs\/heads\//, "")
    : "";
}

/** The terminals whose agents Orca cannot report; `null` when the row does not say. */
function terminalCount(row: Record<string, unknown>): number | null {
  const n = row.unverifiableTerminalCount;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** One `worktree ps` row as a workspace; a row it cannot read whole is an unknown. */
function workspaceOf(
  row: Record<string, unknown>,
  join: JoinTargets,
): Workspace {
  const branch = branchOf(row);
  const listed = agents(row);
  return {
    id: String(row.worktreeId ?? row.path ?? ""),
    path: text(row.path),
    branch,
    ...joins(row, branch, join),
    agents: listed ?? [],
    unverifiableTerminals: unverifiable(row, listed),
    comment: text(row.comment),
    unread: row.unread === true,
  };
}

/** The deadlines of the runtime's calls (`runtime_timeout`, `workspace_timeout`). */
export interface OrcaDeadlines {
  runtimeTimeoutMs: number;
  workspaceTimeoutMs: number;
}

/** The Orca repository that is this checkout: its id and its clone's path. */
async function orcaRepo(
  repo: RepoTarget,
  timeoutSec: number,
): Promise<{ id: string; path: string } | string> {
  const listing = await orca(["repo", "list"], timeoutSec);
  if (typeof listing === "string") return listing;
  const ids = repoIds(listing, repo);
  if (ids === null || ids.length !== 1)
    return `orca repo list names ${ids === null ? "a matching repository without an id" : `${ids.length} repositories`} for ${repo.slug}`;
  const row = (listing.repos as unknown[])
    .filter(isRecord)
    .find((r) => r.id === ids[0]);
  return typeof row?.path === "string"
    ? { id: ids[0] as string, path: row.path }
    : `orca repo list gives ${repo.slug} no clone path`;
}

export function orcaRuntime(
  deadlines: OrcaDeadlines = {
    runtimeTimeoutMs: ORCA_TIMEOUT_SEC * 1000,
    workspaceTimeoutMs: ORCA_TIMEOUT_SEC * 1000,
  },
  /** Whether interactive launches bind their account; tests pass `{ ok: true }`. */
  binding: Binding = ORCA_BINDING,
): SessionRuntime {
  const timeoutSec = Math.max(1, Math.ceil(deadlines.runtimeTimeoutMs / 1000));
  const orcaCall = (args: string[]) => orca(args, timeoutSec);
  return {
    name: "orca",
    interactiveBinding: binding,
    async sessions(repo, join): Promise<SessionsReport> {
      const source = "orca worktree ps";
      const listing = await orcaCall(["repo", "list"]);
      if (typeof listing === "string")
        return { ok: false, source, reason: listing };
      const ids = repoIds(listing, repo);
      if (ids === null)
        return {
          ok: false,
          source,
          reason:
            "orca repo list returned a matched repository without a string id",
        };
      if (ids.length === 0)
        return {
          ok: false,
          source,
          reason: `no Orca repository is ${repo.path} or ${repo.slug}`,
        };
      const ps = await orcaCall([
        "worktree",
        "ps",
        "--limit",
        String(ROW_LIMIT),
      ]);
      if (typeof ps === "string") return { ok: false, source, reason: ps };
      const cut = partial(ps);
      if (cut !== null) return { ok: false, source, reason: cut };
      const all = ps.worktrees as unknown[];
      if (!all.every((w) => isRecord(w) && typeof w.repoId === "string"))
        return {
          ok: false,
          source,
          reason: "orca worktree ps returned a row with no readable repoId",
        };
      const rows = all
        .filter(isRecord)
        .filter(
          (w) => ids.includes(w.repoId as string) && w.isArchived !== true,
        );
      const workspaces = rows.map((row) => workspaceOf(row, join));
      return { ok: true, source, workspaces };
    },
    async openWorkspace(repo, target) {
      const found = await orcaRepo(repo, timeoutSec);
      if (typeof found === "string") return { ok: false, detail: found };
      if ("notices" in target)
        return openNoticesWorkspace(
          found,
          target.notices,
          deadlines.workspaceTimeoutMs,
        );
      return "pr" in target
        ? openPullRequestWorkspace(found, target, deadlines.workspaceTimeoutMs)
        : openItemWorkspace(found, target, deadlines.workspaceTimeoutMs);
    },
    async launch(workspace, stage, _account, key) {
      if (stage.kind === "interactive" && !binding.ok)
        return { ok: false, detail: binding.reason };
      return orcaLaunch(workspace, stage, key, deadlines.runtimeTimeoutMs);
    },
    notify: (target, message) =>
      orcaNotify(target, message, deadlines.runtimeTimeoutMs),
    steer: (session, nudge) =>
      orcaSteer(session, NUDGES[nudge], deadlines.runtimeTimeoutMs),
  };
}

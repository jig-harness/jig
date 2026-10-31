/**
 * The session runtime on Orca. `sessions` reads `orca repo list --json` to
 * find the Orca repository a checkout is, and `orca worktree ps --json` for
 * its workspaces and their agents. A workspace is joined to a pull request
 * by the pull request Orca links to it or by its branch being the pull
 * request's head, and to an item by the issue Orca links to it or by its
 * branch carrying the item's key in the repository's branch form.
 *
 * Orca's command is `ORCA_CLI_COMMAND` when set, else `orca` on `PATH`.
 */
import { realpathSync } from "node:fs";
import { orcaResult, orcaFailure } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import { keyFromBranch } from "../../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { RepoTarget } from "../types.ts";
import {
  type AgentSession,
  type JoinTargets,
  notYet,
  type SessionRuntime,
  type SessionsReport,
  type Workspace,
} from "./port.ts";

/** Seconds one Orca call may take. */
const ORCA_TIMEOUT_SEC = 60;

/** The most rows one listing asks for; a cut page is an unknown. */
const ROW_LIMIT = 2000;

function orcaCommand(): string {
  return process.env.ORCA_CLI_COMMAND?.trim() || "orca";
}

async function orca(args: string[]): Promise<Record<string, unknown> | string> {
  const done = await run([orcaCommand(), ...args, "--json"], {
    timeoutSec: ORCA_TIMEOUT_SEC,
    stderr: "pipe",
  });
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

/** The Orca repository ids that are this checkout, by path or by remote. */
function repoIds(listing: Record<string, unknown>, repo: RepoTarget): string[] {
  const repos = Array.isArray(listing.repos) ? listing.repos : [];
  const path = real(repo.path);
  const remote = `github.com/${repo.slug}`.toLowerCase();
  return repos
    .filter(isRecord)
    .filter((r) => {
      const identity = isRecord(r.gitRemoteIdentity) ? r.gitRemoteIdentity : {};
      return (
        (typeof r.path === "string" && real(r.path) === path) ||
        (typeof identity.canonicalKey === "string" &&
          identity.canonicalKey.toLowerCase() === remote)
      );
    })
    .map((r) => String(r.id));
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
    items: [...new Set([...links.items, ...named.items])].sort(),
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

export function orcaRuntime(): SessionRuntime {
  return {
    name: "orca",
    async sessions(repo, join): Promise<SessionsReport> {
      const source = "orca worktree ps";
      const listing = await orca(["repo", "list"]);
      if (typeof listing === "string")
        return { ok: false, source, reason: listing };
      const ids = repoIds(listing, repo);
      if (ids.length === 0)
        return {
          ok: false,
          source,
          reason: `no Orca repository is ${repo.path} or ${repo.slug}`,
        };
      const ps = await orca(["worktree", "ps", "--limit", String(ROW_LIMIT)]);
      if (typeof ps === "string") return { ok: false, source, reason: ps };
      const cut = partial(ps);
      if (cut !== null) return { ok: false, source, reason: cut };
      const rows = (ps.worktrees as unknown[])
        .filter(isRecord)
        .filter((w) => ids.includes(String(w.repoId)) && w.isArchived !== true);
      const workspaces = rows.map((row) => workspaceOf(row, join));
      return { ok: true, source, workspaces };
    },
    openWorkspace: () => notYet("openWorkspace", "build step 3"),
    launch: () => notYet("launch", "build step 3"),
    notify: () => notYet("notify", "build step 5"),
    steer: () => notYet("steer", "build step 6"),
  };
}

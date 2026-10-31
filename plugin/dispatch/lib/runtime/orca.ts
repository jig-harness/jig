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

function joins(
  row: Record<string, unknown>,
  branch: string,
  join: JoinTargets,
) {
  const prs = new Set<number>();
  const items = new Set<string>();
  const linkedPr = linkValue(row.linkedPR);
  if (typeof linkedPr === "number") prs.add(linkedPr);
  for (const link of [row.linkedIssue, row.linkedLinearIssue]) {
    const value = linkValue(link);
    const key = value === null ? null : itemKey(value, join);
    if (key !== null) items.add(key);
  }
  for (const item of Array.isArray(row.linkedItems) ? row.linkedItems : []) {
    if (!isRecord(item)) continue;
    const value = linkValue(item);
    if (value === null) continue;
    if (item.type === "pr" && typeof value === "number") prs.add(value);
    if (item.type === "issue") {
      const key = itemKey(value, join);
      if (key !== null) items.add(key);
    }
  }
  if (branch !== "") {
    for (const pr of join.pullRequests)
      if (pr.head === branch) prs.add(pr.number);
    const key =
      join.keys === null
        ? null
        : keyFromBranch(branch, join.keys, join.branchPattern);
    if (key !== null) items.add(key);
  }
  return { prs: [...prs].sort((a, b) => a - b), items: [...items].sort() };
}

function agents(row: Record<string, unknown>): AgentSession[] {
  return (Array.isArray(row.agents) ? row.agents : [])
    .filter(isRecord)
    .map((a) => ({
      id: typeof a.paneKey === "string" ? a.paneKey : "",
      state: typeof a.state === "string" ? a.state : "unknown",
      agentType: typeof a.agentType === "string" ? a.agentType : null,
    }));
}

/** Why a listing cannot be read as whole; `null` when it can. */
function partial(ps: Record<string, unknown>): string | null {
  if (ps.truncated === true)
    return `orca worktree ps cut its page short (${String(ps.totalCount)} rows)`;
  const scope = isRecord(ps.hostScope) ? ps.hostScope : {};
  const omitted = Array.isArray(scope.omittedHostIds)
    ? scope.omittedHostIds
    : [];
  return omitted.length > 0
    ? `orca worktree ps does not cover host(s) ${omitted.join(", ")}`
    : null;
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
      const rows = (Array.isArray(ps.worktrees) ? ps.worktrees : [])
        .filter(isRecord)
        .filter((w) => ids.includes(String(w.repoId)) && w.isArchived !== true);
      const workspaces: Workspace[] = rows.map((row) => {
        const branch =
          typeof row.branch === "string"
            ? row.branch.replace(/^refs\/heads\//, "")
            : "";
        return {
          id: String(row.worktreeId ?? row.path ?? ""),
          path: typeof row.path === "string" ? row.path : "",
          branch,
          ...joins(row, branch, join),
          agents: agents(row),
          unverifiableTerminals:
            typeof row.unverifiableTerminalCount === "number"
              ? row.unverifiableTerminalCount
              : 0,
          comment: typeof row.comment === "string" ? row.comment : "",
          unread: row.unread === true,
        };
      });
      return { ok: true, source, workspaces };
    },
    openWorkspace: () => notYet("openWorkspace", "build step 3"),
    launch: () => notYet("launch", "build step 3"),
    notify: () => notYet("notify", "build step 5"),
    steer: () => notYet("steer", "build step 6"),
  };
}

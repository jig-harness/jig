/**
 * `openWorkspace` on Orca: a pull request's head branch's workspace, or an
 * item's new branch's, on the Orca workspace tool's own rules
 * (`shared/orca-workspace/open.ts`): an existing checkout of the branch
 * first, else `orca worktree create` with the pull request or the issue
 * linked and the branch corrected to the one asked for (a new item branch
 * starts from the repository's base), then the repository's create hook
 * once. The whole open runs under
 * `workspace_timeout`: every call is cut to what is left of it, and an open
 * that reaches it stops, its answer lost.
 */
import { orcaCommand } from "../../../shared/orca.ts";
import {
  OrcaError,
  parseOrcaEnvelope,
} from "../../../shared/orca-workspace/envelope.ts";
import { openBranch } from "../../../shared/orca-workspace/open.ts";
import {
  boundedHook,
  type OpenPort,
} from "../../../shared/orca-workspace/port.ts";
import {
  type Context,
  localContext,
  output,
  withLimit,
} from "../../../shared/orca-workspace/runner.ts";
import { failureText } from "../text.ts";
import type { ItemTarget, RuntimeReceipt } from "./port.ts";

function portOn(ctx: Context): OpenPort {
  const orca = orcaCommand(process.env) ?? "orca";
  return {
    host: ctx,
    runHook: boundedHook,
    orcaCall<T>(args: string[], what: string) {
      const done = ctx.run([orca, ...args, "--json"]);
      const envelope = parseOrcaEnvelope<T>(done.stdout);
      if (envelope !== null && !envelope.ok) return envelope;
      if (done.status !== 0)
        throw new OrcaError(
          `${what} failed (exit ${done.status}): ${output(done)}`,
        );
      if (envelope === null)
        throw new OrcaError(`${what}: unreadable output: ${output(done)}`);
      return envelope;
    },
    where: "",
  };
}

/** What links a new item workspace's issue, by tracker: Orca links GitHub and Linear issues, and attaches a Jira key as a reference. */
function itemLink(target: ItemTarget): string[] {
  if (target.tracker === "github")
    return ["--issue", target.item.replace(/^#/, "")];
  if (target.tracker === "linear") return ["--linear-issue", target.item];
  if (target.tracker === "jira") return ["--reference", target.item];
  return [];
}

export function openPullRequestWorkspace(
  repo: { id: string; path: string },
  target: { pr: number; head: string },
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  return open(
    repo,
    {
      branch: target.head,
      comment: `PR #${target.pr}, driven by jig dispatch`,
      createFlags: ["--pr", String(target.pr)],
    },
    timeoutMs,
  );
}

/**
 * The repository's notices workspace: `branch`, cut from the repository's
 * base when new, with nothing linked. The dispatcher writes only its
 * comment and never launches an agent into it.
 */
export function openNoticesWorkspace(
  repo: { id: string; path: string },
  branch: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  return open(
    repo,
    { branch, comment: "jig dispatch notices", createFlags: [] },
    timeoutMs,
  );
}

/** An item's workspace: its branch, from the repository's base when new, its issue linked. */
export function openItemWorkspace(
  repo: { id: string; path: string },
  target: ItemTarget,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  return open(
    repo,
    {
      branch: target.branch,
      comment: `${target.item}, picked up by jig dispatch`,
      createFlags: itemLink(target),
    },
    timeoutMs,
  );
}

async function open(
  repo: { id: string; path: string },
  options: { branch: string; comment: string; createFlags: string[] },
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const lines: string[] = [];
  const ctx = withLimit(
    localContext((line) => lines.push(line)),
    timeoutMs,
  );
  const started = Date.now();
  try {
    const opened = openBranch(portOn(ctx), { repo, ...options });
    return {
      ok: true,
      detail: `${opened.reattached ? "reattached" : "opened"} ${opened.worktree.path}${opened.hookRan ? ", create hook ran" : ""}`,
      workspace: { id: opened.worktree.id, path: opened.worktree.path },
    };
  } catch (error) {
    return {
      ok: false,
      lost: Date.now() - started >= timeoutMs,
      detail: [failureText(error), ...lines.slice(-3)].join("; "),
    };
  }
}

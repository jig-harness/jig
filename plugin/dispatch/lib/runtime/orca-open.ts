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
 *
 * A checkout Orca does not list that holds the branch is detached when it
 * is idle, judged with the drive's records of what drives a tree
 * (`tree-drivers.ts`); one in use refuses the open, and the receipt names
 * it (`busyHolder`) for the notice a person gets.
 *
 * A workspace the open creates is named by the target's `dispatched` name
 * (`--name`) and carries its mark as its comment (`--comment`); one it
 * reattaches to keeps its name and its comment, and `launch` adds the mark
 * to that comment.
 */
import { orcaCommandOrInstalled } from "../../../shared/orca.ts";
import { BusyHolderError } from "../../../shared/orca-workspace/holder.ts";
import { openBranch } from "../../../shared/orca-workspace/open.ts";
import {
  boundedHook,
  type OpenPort,
  orcaAnswer,
} from "../../../shared/orca-workspace/port.ts";
import {
  type Context,
  localContext,
  withLimit,
} from "../../../shared/orca-workspace/runner.ts";
import { treeDrivers } from "../../../skills/drive-pr/scripts/lib/state/tree-drivers.ts";
import { failureText } from "../text.ts";
import { call } from "./orca-comment.ts";
import type {
  Dispatched,
  ItemTarget,
  NoticesTarget,
  PullRequestTarget,
  RuntimeReceipt,
} from "./port.ts";

function portOn(ctx: Context): OpenPort {
  const orca = orcaCommandOrInstalled(process.env);
  return {
    host: ctx,
    runHook: boundedHook,
    orcaCall: <T>(args: string[], what: string) =>
      orcaAnswer<T>(ctx.run([orca, ...args, "--json"]), what),
    where: "",
    drivers: treeDrivers,
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
  target: PullRequestTarget,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  return open(
    repo,
    {
      branch: target.head,
      dispatched: target.dispatched,
      createFlags: ["--pr", String(target.pr)],
    },
    timeoutMs,
  );
}

/**
 * The repository's notices workspace: its branch, cut from the
 * repository's base when new, with nothing linked. The dispatcher writes
 * only its comment and never launches an agent into it, so the
 * repository's create hook does not run there (what it installs would be
 * ignored content that keeps the workspace from being retired), and the first
 * terminal Orca gives a new workspace is closed (`orca terminal close
 * --all`): the card is its comment, not an idle shell. A close that fails
 * leaves the workspace opened, the failure in the receipt's detail.
 */
export async function openNoticesWorkspace(
  repo: { id: string; path: string },
  target: NoticesTarget,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const started = Date.now();
  const opened = await open(
    repo,
    {
      branch: target.notices,
      dispatched: target.dispatched,
      createFlags: [],
      createHook: false,
    },
    timeoutMs,
  );
  if (!opened.ok || opened.workspace === undefined || opened.reattached)
    return withoutReattached(opened);
  const closed = await call(
    [
      "terminal",
      "close",
      "--worktree",
      `path:${opened.workspace.path}`,
      "--all",
    ],
    Math.max(1, timeoutMs - (Date.now() - started)),
  );
  return withoutReattached({
    ...opened,
    ...(closed.ok
      ? {}
      : {
          cleanupFailure: `${closed.why}; inspect the workspace's terminals, then retry closing the idle initial shell with Orca; automatic retries could close personal work`,
        }),
    detail: closed.ok
      ? `${opened.detail}, its terminals closed`
      : `${opened.detail}; its terminals were not closed: ${closed.why}`,
  });
}

function withoutReattached(
  receipt: RuntimeReceipt & { reattached?: boolean },
): RuntimeReceipt {
  const { reattached: _, ...rest } = receipt;
  return rest;
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
      dispatched: target.dispatched,
      createFlags: itemLink(target),
    },
    timeoutMs,
  );
}

async function open(
  repo: { id: string; path: string },
  options: {
    branch: string;
    dispatched: Dispatched;
    createFlags: string[];
    createHook?: boolean;
  },
  timeoutMs: number,
): Promise<RuntimeReceipt & { reattached?: boolean }> {
  const lines: string[] = [];
  const ctx = withLimit(
    localContext((line) => lines.push(line)),
    timeoutMs,
  );
  const started = Date.now();
  try {
    const opened = openBranch(portOn(ctx), {
      repo,
      branch: options.branch,
      name: options.dispatched.name,
      comment: options.dispatched.mark,
      createFlags: options.createFlags,
      ...(options.createHook === undefined
        ? {}
        : { createHook: options.createHook }),
    });
    return {
      ok: true,
      detail: `${opened.reattached ? "reattached" : "opened"} ${opened.worktree.path}${opened.hookRan ? ", create hook ran" : ""}`,
      workspace: { id: opened.worktree.id, path: opened.worktree.path },
      reattached: opened.reattached,
    };
  } catch (error) {
    return {
      ok: false,
      lost: Date.now() - started >= timeoutMs,
      detail: [failureText(error), ...lines.slice(-3)].join("; "),
      ...(error instanceof BusyHolderError
        ? {
            busyHolder: {
              path: error.path,
              branch: error.branch,
              reasons: error.reasons,
            },
          }
        : {}),
    };
  }
}

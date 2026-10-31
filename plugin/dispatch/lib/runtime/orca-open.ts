/**
 * `openWorkspace` on Orca for a pull request: its head branch's workspace,
 * on the Orca workspace tool's own rules (`shared/orca-workspace/open.ts`):
 * an existing checkout of the branch first, else `orca worktree create`
 * with the pull request linked and the branch corrected to the head, then
 * the repository's create hook once. The whole open runs under
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
import type { RuntimeReceipt } from "./port.ts";

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

export async function openPullRequestWorkspace(
  repo: { id: string; path: string },
  target: { pr: number; head: string },
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const lines: string[] = [];
  const ctx = withLimit(
    localContext((line) => lines.push(line)),
    timeoutMs,
  );
  const started = Date.now();
  try {
    const opened = openBranch(portOn(ctx), {
      repo,
      branch: target.head,
      comment: `PR #${target.pr}, driven by jig dispatch`,
      createFlags: ["--pr", String(target.pr)],
    });
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

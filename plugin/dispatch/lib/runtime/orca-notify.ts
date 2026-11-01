/**
 * `notify` on Orca: the workspace's comment set to the message and the
 * workspace marked unread, in one call (`orca worktree set --worktree
 * path:<path> --comment <message> --unread`), which Orca's phone app shows
 * as an unread workspace with its comment. The comment is then read back
 * (`orca worktree show`): that read is the receipt, and the tick counts a
 * message as sent only once it finds the message's key in it. Each call
 * runs under the runtime's deadline; an answer past it is lost.
 */
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import type { RuntimeReceipt } from "./port.ts";

function seconds(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

async function call(
  args: string[],
  timeoutMs: number,
): Promise<
  { ok: true; result: unknown } | { ok: false; lost: boolean; why: string }
> {
  const done = await run(
    [orcaCommand(process.env) ?? "orca", ...args, "--json"],
    {
      timeoutSec: seconds(timeoutMs),
      stderr: "pipe",
    },
  );
  if (done.timedOut)
    return {
      ok: false,
      lost: true,
      why: `orca ${args.slice(0, 2).join(" ")} gave no answer within ${seconds(timeoutMs)}s`,
    };
  const envelope = orcaEnvelope(done.stdout);
  if (done.code === 0 && envelope?.ok === true)
    return { ok: true, result: envelope.result };
  return {
    ok: false,
    // An answer that is not Orca's envelope says nothing about what was written.
    lost: envelope === null,
    why: `orca ${args.slice(0, 2).join(" ")} failed (exit ${done.code}): ${(done.stderr || done.stdout).trim().slice(0, 200)}`,
  };
}

/** The comment in `worktree show`'s answer; `null` when it names none. */
function commentOf(result: unknown): string | null {
  const worktree = isRecord(result) ? result.worktree : undefined;
  return isRecord(worktree) && typeof worktree.comment === "string"
    ? worktree.comment
    : null;
}

export async function orcaNotify(
  target: { id: string; path: string },
  message: string,
  timeoutMs: number,
): Promise<RuntimeReceipt> {
  const selector = `path:${target.path}`;
  const set = await call(
    [
      "worktree",
      "set",
      "--worktree",
      selector,
      "--comment",
      message,
      "--unread",
    ],
    timeoutMs,
  );
  if (!set.ok) return { ok: false, lost: set.lost, detail: set.why };
  const shown = await call(
    ["worktree", "show", "--worktree", selector],
    timeoutMs,
  );
  if (!shown.ok)
    return {
      ok: false,
      lost: true,
      detail: `the comment was written, and could not be read back: ${shown.why}`,
    };
  const comment = commentOf(shown.result);
  return comment === null
    ? {
        ok: false,
        lost: true,
        detail: "orca worktree show named no comment to read back",
      }
    : {
        ok: true,
        detail: `${target.path} marked unread with the message as its comment`,
        comment,
      };
}

/**
 * A workspace's comment on Orca, read with `orca worktree show` and written
 * with `orca worktree set --comment`, each call under the runtime's
 * deadline: what `notify` writes a message through, and what `launch` adds
 * the dispatched mark to.
 */
import { type CardLock, withCardLock } from "../../../shared/orca-card-lock.ts";
import { orcaCommand, orcaEnvelope } from "../../../shared/orca.ts";
import { isRecord } from "../../../shared/guards.ts";
import { run } from "../../../shared/proc.ts";
import { marksIn, withMark } from "./port.ts";

/** The remaining budget in seconds, fractional: a call never outlives the deadline. */
function seconds(ms: number): number {
  return Math.max(0.001, ms / 1000);
}

/** Hold the card lock with one monotonic budget covering its wait and the operation. */
export function withCardDeadline<T>(
  path: string,
  timeoutMs: number,
  operation: (remaining: () => number) => Promise<T>,
  lock: CardLock,
): Promise<{ value: T } | null> {
  const start = performance.now();
  const remaining = () => timeoutMs - (performance.now() - start);
  return lock(path, () => operation(remaining), {
    waitMs: Math.max(0, Math.min(timeoutMs, 5000)),
  });
}

type CallAnswer =
  | { ok: true; result: unknown }
  | { ok: false; lost: boolean; why: string };

/** One Orca call with `--json`; an answer past the deadline, or one that is not Orca's envelope, is lost. */
export async function call(
  args: string[],
  timeoutMs: number,
): Promise<CallAnswer> {
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
      why: `orca ${args.slice(0, 2).join(" ")} gave no answer within ${seconds(timeoutMs).toFixed(3)}s`,
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

/** The comment of the workspace at `path`, or why it could not be read. */
async function readComment(
  path: string,
  timeoutMs: number,
): Promise<{ comment: string } | { lost: boolean; why: string }> {
  const shown = await call(
    ["worktree", "show", "--worktree", `path:${path}`],
    timeoutMs,
  );
  if (!shown.ok) return { lost: shown.lost, why: shown.why };
  const comment = commentOf(shown.result);
  return comment === null
    ? { lost: true, why: "orca worktree show named no comment" }
    : { comment };
}

/**
 * Add `mark` to the comment of the workspace at `path`, once, keeping what
 * the comment holds: the comment is read first, written only when it lacks
 * the mark, and read back to see the mark in it, since an acknowledged write
 * proves nothing about the comment. All the calls share one deadline. `null`
 * when the comment carries the mark, else why it does not.
 */
export async function markComment(
  path: string,
  mark: string,
  timeoutMs: number,
  lock: CardLock = withCardLock,
): Promise<string | null> {
  const until = Date.now() + timeoutMs;
  const [added] = marksIn(mark);
  if (added === undefined) return "it is not a dispatched mark";
  // The read, the write and the read-back hold the card's comment lock, the
  // one every comment writer takes, so a notification written meanwhile is
  // not replaced by this write; the wait for it is part of the deadline.
  let locked: { value: string | null } | null;
  try {
    locked = await lock(
      path,
      () => markUnlocked(path, mark, added.line, until),
      { waitMs: Math.max(0, Math.min(timeoutMs, 5000)) },
    );
  } catch (error) {
    return `the card's comment lock could not be taken: ${error instanceof Error ? error.message : String(error)}`;
  }
  return locked === null
    ? "another writer held the card's comment past the deadline"
    : locked.value;
}

/** `markComment`'s read, write and read-back, holding the card's lock; `null` when the mark is in the comment. */
async function markUnlocked(
  path: string,
  mark: string,
  line: string,
  until: number,
): Promise<string | null> {
  const first = until - Date.now();
  if (first <= 0) return "no time was left to read it";
  const read = await readComment(path, first);
  if ("why" in read) return read.why;
  const next = withMark(read.comment, mark);
  if (next === null) return null;
  const left = until - Date.now();
  if (left <= 0) return "no time was left to write it";
  const set = await call(
    ["worktree", "set", "--worktree", `path:${path}`, "--comment", next],
    left,
  );
  if (!set.ok) return set.why;
  const after = until - Date.now();
  if (after <= 0) return "no time was left to read it back";
  const back = await readComment(path, after);
  if ("why" in back) return `it could not be read back: ${back.why}`;
  return marksIn(back.comment).some((m) => m.line === line)
    ? null
    : "orca accepted the write, but the comment read back without the mark";
}

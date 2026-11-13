/**
 * `--apply` for a stalled pickup's finished work (`stalled-pr.ts`), on the
 * host that owns the repository: each item the plan names moves to its
 * `pr_open` state, once.
 *
 * 1. the fresh read: the item still reads in the state the plan read it in,
 *    and a fresh read of the runtime finds no session holding it, since
 *    observation and application are apart by the launches in between;
 * 2. the move to `pr_open`, never to done;
 * 3. a comment from a fixed text, naming the pull request and that the
 *    dispatcher made the move, with the association marker `do-item` writes
 *    when it opens a pull request (`hasPullAssociation`), so the item's
 *    linked pull request reads the same either way.
 *
 * The move comes before the comment: a comment that did not post is
 * reported and not tried again, while a move that did not happen leaves the
 * item where it was for a later tick. Every failure is a value on the
 * report; nothing here throws.
 */
import type { Tracker } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import { isRateLimited } from "../../../shared/tracker-budget.ts";
import { holding } from "../holding.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { failureText } from "../text.ts";
import type { PrOpenMove, RepoReport } from "../types.ts";

/** The tracker operations a move uses. */
export type MoveTracker = Pick<
  Tracker,
  "getIssue" | "transition" | "postComment"
>;

/** How long one tracker call of a move may take at most. */
const CALL_MS = 60_000;

/** What the tick leaves a move: the time it has, and a fresh read of the runtime's sessions. */
export interface MoveRoom {
  /** Milliseconds the tick has left for its own work, receipt reserve excluded; `null` where it keeps no deadline. */
  left: () => number | null;
  /** The runtime's sessions, read now. */
  sessions: () => Promise<SessionsReport>;
}

/** How long the next call may take: `CALL_MS`, or what the tick has left when that is less; `null` when none is left. */
function allowance(room: MoveRoom): number | null {
  const left = room.left();
  if (left === null) return CALL_MS;
  return left > 0 ? Math.min(CALL_MS, left) : null;
}

const OUT_OF_TIME =
  "this tick has no time left for the move; a later tick retries it";

/** A read that cannot take a signal, bounded by `ms`: it rejects when the time is up, the tracker's own call left to finish alone. */
function within<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the read took longer than ${ms / 1000}s`)),
      ms,
    );
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
}

/** The comment the dispatcher posts on an item it moved: a fixed text. */
function prOpenComment(move: PrOpenMove): string {
  return [
    `The dispatcher moved this item to ${move.to}: pull request #${move.pr} (${move.url}) was open from ${move.branch} when the tick read it, the branch a pickup this host launched for it worked on, and links it.`,
    "",
    `<!-- do-item-pr: ${move.url} -->`,
  ].join("\n");
}

function done(
  move: PrOpenMove,
  outcome: NonNullable<PrOpenMove["outcome"]>,
  detail: string,
): PrOpenMove {
  return { ...move, outcome, detail };
}

/** Why the item must not move now; `null` when the fresh read still finds it where the plan did. */
async function changed(
  tracker: MoveTracker,
  move: PrOpenMove,
  room: MoveRoom,
): Promise<string | null> {
  const ms = allowance(room);
  if (ms === null) return OUT_OF_TIME;
  const now = await within(tracker.getIssue(move.target), ms);
  if (now === null) return `${move.target} did not read again`;
  if (now.state.name.trim().toLowerCase() !== move.from.trim().toLowerCase())
    return `${move.target} is now in ${now.state.name}, not the ${move.from} the plan read`;
  const sessionMs = allowance(room);
  if (sessionMs === null) return OUT_OF_TIME;
  const sessions = await within(room.sessions(), sessionMs);
  const held = holding(sessions, (w) => w.items.includes(move.target));
  if (held.kind === "running")
    return `a session holds ${move.target} now, so it is not finished work`;
  if (held.kind === "unknown")
    return `whether a session holds ${move.target} cannot be told now: ${held.reason}`;
  return null;
}

/** One move: its fresh read, the move, then the comment. */
async function moveOne(
  tracker: MoveTracker,
  move: PrOpenMove,
  room: MoveRoom,
): Promise<PrOpenMove> {
  try {
    const why = await changed(tracker, move, room);
    if (why !== null) return done(move, "waits", why);
    const ms = allowance(room);
    if (ms === null) return done(move, "waits", OUT_OF_TIME);
    await tracker.transition(move.target, "pr_open", AbortSignal.timeout(ms));
  } catch (error) {
    return done(
      move,
      isRateLimited(error) ? "waits" : "refused",
      `the tracker did not move ${move.target} to ${move.to}: ${failureText(error)}`,
    );
  }
  const ms = allowance(room);
  if (ms === null)
    return done(
      move,
      "moved",
      `moved ${move.target} to ${move.to} for pull request #${move.pr}, but its comment did not post: ${OUT_OF_TIME}`,
    );
  try {
    await tracker.postComment(
      move.target,
      prOpenComment(move),
      AbortSignal.timeout(ms),
    );
  } catch (error) {
    return done(
      move,
      "moved",
      `moved ${move.target} to ${move.to} for pull request #${move.pr}, but its comment did not post: ${failureText(error)}`,
    );
  }
  return done(
    move,
    "moved",
    `moved ${move.target} to ${move.to} for pull request #${move.pr}, and commented on it`,
  );
}

/** `--apply` for one repository's moves to `pr_open`; `room` bounds each call by the tick's time and reads the runtime afresh. */
export async function applyPrOpenMoves(
  report: RepoReport,
  tracker: MoveTracker,
  room: MoveRoom,
): Promise<void> {
  const moves = report.prOpenMoves ?? [];
  const applied: PrOpenMove[] = [];
  for (const move of moves) applied.push(await moveOne(tracker, move, room));
  if (applied.length > 0) report.prOpenMoves = applied;
}

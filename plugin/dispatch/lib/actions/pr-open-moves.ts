/**
 * `--apply` for a stalled pickup's finished work (`stalled-pr.ts`), on the
 * host that owns the repository: each item the plan names moves to its
 * `pr_open` state, once.
 *
 * 1. the fresh read: the item still reads in the state the plan read it in;
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
import { failureText } from "../text.ts";
import type { PrOpenMove, RepoReport } from "../types.ts";

/** The tracker operations a move uses. */
export type MoveTracker = Pick<
  Tracker,
  "getIssue" | "transition" | "postComment"
>;

/** How long one tracker call of a move may take. */
const CALL_MS = 60_000;

/** A read that cannot take a signal, bounded by `CALL_MS`: it rejects when the time is up, the tracker's own call left to finish alone. */
function within<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the read took longer than ${CALL_MS / 1000}s`)),
      CALL_MS,
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
): Promise<string | null> {
  const now = await within(tracker.getIssue(move.target));
  if (now === null) return `${move.target} did not read again`;
  return now.state.name.trim().toLowerCase() === move.from.trim().toLowerCase()
    ? null
    : `${move.target} is now in ${now.state.name}, not the ${move.from} the plan read`;
}

/** One move: its fresh read, the move, then the comment. */
async function moveOne(
  tracker: MoveTracker,
  move: PrOpenMove,
  late: () => string | null,
): Promise<PrOpenMove> {
  const over = late();
  if (over !== null) return done(move, "waits", over);
  try {
    const why = await changed(tracker, move);
    if (why !== null) return done(move, "waits", why);
    const out = late();
    if (out !== null) return done(move, "waits", out);
    await tracker.transition(
      move.target,
      "pr_open",
      AbortSignal.timeout(CALL_MS),
    );
  } catch (error) {
    return done(
      move,
      isRateLimited(error) ? "waits" : "refused",
      `the tracker did not move ${move.target} to ${move.to}: ${failureText(error)}`,
    );
  }
  const out = late();
  if (out !== null)
    return done(
      move,
      "moved",
      `moved ${move.target} to ${move.to} for pull request #${move.pr}, but its comment did not post: ${out}`,
    );
  try {
    await tracker.postComment(
      move.target,
      prOpenComment(move),
      AbortSignal.timeout(CALL_MS),
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

/** `--apply` for one repository's moves to `pr_open`; `late` says when the tick has run out of time. */
export async function applyPrOpenMoves(
  report: RepoReport,
  tracker: MoveTracker,
  late: () => string | null = () => null,
): Promise<void> {
  const moves = report.prOpenMoves ?? [];
  const applied: PrOpenMove[] = [];
  for (const move of moves) applied.push(await moveOne(tracker, move, late));
  if (applied.length > 0) report.prOpenMoves = applied;
}

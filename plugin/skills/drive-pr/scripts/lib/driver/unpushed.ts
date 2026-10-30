/**
 * Commits in the driven tree that the pull request's head lacks, measured
 * before every gate.
 *
 * A pass can end its turn after committing a round's fixes and before
 * `finish-round.ts` pushes them, whatever it exits with; a drive can be armed
 * over local commits nobody pushed. Local HEAD is then ahead of the PR head,
 * and a gate told nothing reads that as `HEAD_LAG` and polls for its whole
 * `--timeout`, although no push happened and the wait cannot succeed. So the
 * driver measures the tree first: commits on top of the head branch's remote
 * ref go to the gate as an inherited head (`--inherited-head`), and the
 * round's pass is told to push them. Commits that do not build on that ref
 * are no fast-forward of the PR head, so no round could push them and the gate
 * would wait on them all the same: the drive stops at once, naming them.
 *
 * A head that was pushed and that the API has not caught up with leaves local
 * HEAD on the remote ref, with nothing to count: the gate is told nothing,
 * and its `HEAD_LAG` poll waits for the API as before.
 */
import type { DriveRoundContext } from "./round-context.ts";

import { unpushedBase } from "./../driven-branch.ts";

import {
  describeLeftovers,
  type PassLeftovers,
  passLeftovers,
} from "./restart.ts";

/**
 * The head the next gate is handed when the tree holds commits on top of the
 * driven branch's remote ref: positively counted, and not shown to stand
 * apart from that ref. `''` otherwise, so a tree with no ref to count against
 * (no upstream and no attach) or with uncommitted edits alone is told
 * nothing.
 */
export function unpushedHeadOf(l: PassLeftovers): string {
  if (l.head === null || l.unpushed === null || l.unpushed <= 0) return "";
  return l.onRemote === false ? "" : l.head;
}

/**
 * Why the tree's commits cannot be handed to a round, or `null` when they can
 * (or there are none): local HEAD has commits of its own and does not contain
 * the driven branch's remote ref, so pushing it is no fast-forward.
 */
export function strandedReason(l: PassLeftovers): string | null {
  if (l.unpushed === null || l.unpushed <= 0 || l.onRemote !== false)
    return null;
  return `local HEAD ${l.head ?? "(unreadable)"} does not build on ${unpushedBase()}: its ${l.unpushed} commit(s) of its own are no fast-forward of the pull request's head, so no round can push them`;
}

/** The notice a round's pass reads while the tree holds unpushed commits. */
export function unpushedNotice(l: PassLeftovers, head: string): string {
  return [
    `UNPUSHED COMMITS: local HEAD ${head} carries ${l.unpushed} commit(s) the pull request's head does not have. A pass ended without pushing them, or the drive was armed over them; until they are pushed, a reply that promised them is not true on the pull request and CI runs on the old head. What is in this tree:`,
    ...describeLeftovers(l),
    "Validate what is sound and push it through finish-round with this round's own fixes; discard what is not on purpose, then triage as usual.",
    `Run the § 1 gate with \`--inherited-head ${head}\`: without it the gate reads the unpushed commits as HEAD_LAG.`,
  ].join("\n");
}

/**
 * Measure the tree before a gate. Sets the head the gate is handed and the
 * notice the round's pass reads, or returns the exit that stops the drive
 * over commits no round can push.
 */
export async function measureUnpushed(
  context: DriveRoundContext,
): Promise<number | null> {
  const l = await passLeftovers();
  const stranded = strandedReason(l);
  if (stranded !== null) {
    console.error(`PR #${context.pr}: ${stranded}; stopping before the gate.`);
    for (const line of describeLeftovers(l)) console.error(`  ${line}`);
    console.error(
      "  Reconcile the tree with the pull request's head (rebase the commits onto it, or reset to it and keep what is sound), then re-arm.",
    );
    return 1;
  }
  const head = unpushedHeadOf(l);
  context.unpushedNotice = head === "" ? "" : unpushedNotice(l, head);
  if (head === "" || context.inheritedHead === head) return null;
  context.inheritedHead = head;
  console.error(
    `local HEAD ${head.slice(0, 12)} carries ${l.unpushed} commit(s) the pull request's head lacks; the gate accepts it as an inherited head and the round's pass is told to push them.`,
  );
  for (const line of describeLeftovers(l)) console.error(`  ${line}`);
  return null;
}

/**
 * The unpushed-commits notice for the next pass, unless the notice it is
 * already given names the same inherited head (a pass killed at its
 * deadline is told it in its restart notice).
 */
export function unpushedNoticeFor(
  context: Pick<
    DriveRoundContext,
    "inheritedHead" | "passNotice" | "unpushedNotice"
  >,
): string {
  const named = `--inherited-head ${context.inheritedHead}`;
  return context.inheritedHead !== "" && context.passNotice.includes(named)
    ? ""
    : context.unpushedNotice;
}

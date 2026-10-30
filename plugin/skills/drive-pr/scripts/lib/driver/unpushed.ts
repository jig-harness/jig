/**
 * Work in the driven tree that the pull request's head lacks, measured before
 * every gate: commits nobody pushed, and edits nobody committed.
 *
 * A pass can end its turn after committing a round's fixes and before
 * `finish-round.ts` pushes them, or after editing and before committing,
 * whatever it exits with; a drive can be armed over local commits nobody
 * pushed. Local HEAD is then ahead of the PR head, and a gate told nothing
 * reads that as `HEAD_LAG` and polls for its whole `--timeout`, although no
 * push happened and the wait cannot succeed; over edits alone it can read the
 * PR as converged, and the drive then stops over a dirty tree. So the driver
 * measures the tree first and hands the gate local HEAD as an inherited head
 * (`--inherited-head`): ahead of the PR head the gate accepts it in place of
 * head lag, on the PR head it owes the round that settles the edits, and the
 * round's pass is told what it inherits. Commits that do not build on the
 * head branch's remote ref are no fast-forward of the PR head, so no round
 * could push them and the gate would wait on them all the same: the drive
 * stops at once, naming them.
 *
 * The answer is the tree's as measured now, not what an earlier measurement
 * or a killed pass left recorded: a pass that pushed the commits it inherited
 * and then stopped short of completing (a usage wall slept through) leaves
 * nothing to hand on, and the gate polls the push's lag as before. Only a
 * probe that fails keeps the earlier answer, and a ref the commits are
 * counted against is taken as absent only when git confirms it absent. Edits
 * count only when their content differs from what the tree held before the
 * last completed pass ran (at arm, until one completes), so a further edit to
 * a file already shown as modified counts: a tree dirty before the drive, or
 * edits a pass was handed and left as they were, still stop the drive at
 * convergence.
 */
import type { DriveRoundContext } from "./round-context.ts";

import { unpushedBase } from "./../driven-branch.ts";

import {
  describeLeftovers,
  type PassLeftovers,
  passLeftovers,
} from "./restart.ts";

/**
 * The head the next gate is handed: local HEAD while the tree holds commits
 * on top of the driven branch's remote ref (and not shown to stand apart from
 * it) or uncommitted edits other than `editsBefore`, what the tree held
 * before the last completed pass ran; `''` for a tree with neither, or whose
 * commits stand apart from the ref (`strandedReason`); `null` when a probe
 * failed and the earlier answer stands. Edits that were already there are not
 * a pass's to settle, and the drive stops over them at convergence (exit 12).
 */
export function leftoverHeadOf(
  l: PassLeftovers,
  editsBefore: string | null = "",
): string | null {
  if (l.head === null) return null;
  if (l.unpushed !== null && l.unpushed > 0)
    return l.onRemote === false ? "" : l.head;
  if (l.uncommitted === null || l.edits === null) return null;
  if (l.uncommitted !== "" && l.edits !== editsBefore) return l.head;
  // A ref git confirms absent (no upstream and no attach) is a tree with no
  // commits to hand on; a count that failed over a ref that may exist is not.
  return l.unpushed === 0 || (l.unpushed === null && l.baseExists === false)
    ? ""
    : null;
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

/** The notice a round's pass reads while the tree holds work the PR lacks. */
export function unpushedNotice(l: PassLeftovers, head: string): string {
  const opening =
    l.unpushed !== null && l.unpushed > 0
      ? `UNPUSHED COMMITS: local HEAD ${head} carries ${l.unpushed} commit(s) the pull request's head does not have. A pass ended without pushing them, or the drive was armed over them; until they are pushed, a reply that promised them is not true on the pull request and CI runs on the old head. What is in this tree:`
      : `UNCOMMITTED EDITS: the tree at local HEAD ${head} holds edits no commit carries. A pass ended without committing them; until they are pushed, a reply that promised them is not true on the pull request, and the drive cannot converge over them. What is in this tree:`;
  return [
    opening,
    ...describeLeftovers(l),
    "Validate what is sound and push it through finish-round with this round's own fixes; discard what is not on purpose, then triage as usual.",
    `Run the § 1 gate with \`--inherited-head ${head}\`: without it the gate reads unpushed commits as HEAD_LAG, and a tree with only uncommitted edits as converged.`,
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
  context.uncommittedMeasured = l.edits;
  context.uncommittedBeforePass ??= l.edits;
  const head = leftoverHeadOf(l, context.uncommittedBeforePass);
  if (head === null) return null;
  context.unpushedNotice = head === "" ? "" : unpushedNotice(l, head);
  if (context.inheritedHead === head) return null;
  const was = context.inheritedHead;
  context.inheritedHead = head;
  if (head === "") {
    console.error(
      `local HEAD ${was.slice(0, 12)} no longer carries work the pull request's head lacks; the gate is no longer handed it as an inherited head.`,
    );
    return null;
  }
  console.error(
    `local HEAD ${head.slice(0, 12)} carries work the pull request's head lacks; the gate accepts it as an inherited head and the round's pass is told to push it.`,
  );
  for (const line of describeLeftovers(l)) console.error(`  ${line}`);
  return null;
}

/**
 * The leftovers notice for the next pass, unless the notice it is already
 * given names the same inherited head (a pass killed at its deadline is told
 * it in its restart notice).
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

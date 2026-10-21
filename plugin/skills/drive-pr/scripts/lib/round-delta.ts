import { definedFields } from "../../../../shared/defined-fields.ts";
/**
 * Shared "round delta" resolution: which base a caller should diff this
 * round's local tree against, and the file list that diff produces.
 *
 * Extracted from `round-plan.ts` so a second caller —
 * `finish-round.ts`'s own untriaged-thread guard — can ask the identical
 * question ("what did this round's own commits touch, and against what
 * base") without hand-copying the git-diff-since-verified-sha logic a second
 * time. `references/consistency.md` names exactly this class of
 * drift: state/timing logic duplicated across scripts is the recurring
 * defect shape in this skill.
 *
 * `readVerifiedSha` and `changedFilesSince` are VERBATIM moves out of
 * `round-plan.ts` — same git call args, same error handling, same
 * fail-open note on the `{ a; b; } | sort -u` grouping trap `changedFilesSince`
 * guards against (see its own comment). This is a refactor for reuse, not a
 * behavior change: `round-plan.ts`'s own test coverage
 * (`__tests__/drive-pr.test.ts`, `describe('round-plan.ts', …)`) exercises
 * every branch of both functions already and must keep passing unchanged
 * against this module.
 *
 * `roundBase` is NEW — it did not exist as a standalone function in
 * `round-plan.ts`. It wraps the same fail-closed-to-cumulative-base decision
 * `round-plan.ts`'s Testbox-decay block already made (an empty verified SHA,
 * one this clone cannot resolve, or one that is not an ancestor of HEAD all
 * keep the cumulative answer — see that block's own comments for why each
 * check exists), but turns it into an actual usable BASE rather than merely
 * a decay note. `round-plan.ts` never needed that: its own cumulative `base`
 * was already in scope by the time the decay block ran, computed once at the
 * top of the script for every cumulative-mode invocation. A caller with no
 * such `base` already at hand — `finish-round.ts`'s guard is exactly that —
 * needs `roundBase` to produce one, which is the whole reason this function
 * exists as a distinct export rather than being folded back into
 * `readVerifiedSha`.
 *
 * `timeoutSec` on every exported function here is an optional TIGHTENING,
 * never a loosening — the same contract `ghCall` documents for its own
 * parameter. `round-plan.ts`'s own call sites omit it deliberately (its own
 * inline `git` calls are unbounded too, and this module must not become the
 * one bounded seam in an otherwise-unbounded script); `finish-round.ts`'s
 * `checkUntriagedThreads` passes its already-computed `gitCallTimeoutSeconds`
 * budget, matching every OTHER local `git` call that function makes. A stuck
 * lock in a shared worktree is a local-contention hang, not a network one —
 * `lib/proc.ts`'s own `git` header argues local calls "cannot hang on a
 * network", which is true and beside the point here.
 */

import { isGitSha, short } from "./cli.ts";
import { prBaseRef } from "./overlay.ts";
import { git, run, tsArgv } from "./proc.ts";

/**
 * The last SHA `finish-round.ts` verified and stamped for this PR
 * (`drive-state.ts verified [pr]`), or `''` when the read succeeded and none is
 * recorded, or `null` when the read itself FAILED (non-zero exit) — a
 * distinction earlier callers collapsed to `''` either way: `roundBase` below
 * then could not tell "no round has verified yet" (legitimately falls back to
 * the cumulative merge-base) from "the state read is broken" (must fail closed
 * instead of silently falling back to the same place). `pr === ''` asks
 * `drive-state.ts` to resolve the PR from the current branch, the same as every
 * other caller in this skill that accepts an optional PR argument.
 */
export async function readVerifiedSha(
  pr: string,
  driveStatePath: string,
  timeoutSec?: number,
): Promise<string | null> {
  const args = pr === "" ? ["verified"] : ["verified", pr];
  const r = await run(tsArgv(driveStatePath, args), {
    stderr: "ignore",
    ...definedFields({ timeoutSec }),
  });
  if (r.code !== 0) return null;
  return r.stdout.trim();
}

/**
 * Every file changed since `since` — tracked (`git diff --no-renames
 * --name-only`) unioned with untracked (`git ls-files --others
 * --exclude-standard`) — or `null` when either read fails.
 *
 * Untracked files count: a round that adds a new file has not staged it yet,
 * and a plan that ignores it validates the wrong set.
 *
 * Each step is captured and CHECKED on its own rather than run inside one
 * grouped pipeline. The bash `{ a; b; } | sort -u` grouping reported only
 * `sort`'s status — even under `set -euo pipefail`, because the group's own
 * status is its LAST command's, so a failing `git diff` followed by a
 * succeeding `git ls-files` exits 0 and its missing output reads as "nothing
 * changed". Measured, not inferred. A caller that folds a failed read into
 * "empty" turns this fail-closed contract into a fail-OPEN one — see each
 * call site's own handling of a `null` return.
 *
 * This is the CUMULATIVE diff — every file that differs between `since` and
 * the current tree, INCLUDING whatever a merge commit brought in along the
 * way. `round-plan.ts` wants exactly that (its own header: "the combined
 * tree is what gets pushed, so the combined tree is what gets validated").
 * A caller that wants only the files THIS round's own non-merge commits
 * touched — `finish-round.ts`'s untriaged-thread guard is exactly that —
 * wants `changedFilesSinceExcludingMerges` below instead.
 */
export async function changedFilesSince(
  root: string,
  since: string,
  timeoutSec?: number,
): Promise<string[] | null> {
  // `-z` on both reads: `core.
  // quotePath=false` (below, and on `changedFilesSinceExcludingMerges`) stops
  // git from backslash-octal-escaping a NON-ASCII path, but it does not stop
  // git quoting a path containing a literal `"` or `\` — those are quoted
  // regardless of `core.quotePath`. A quoted path split on `\n` would never
  // match the `touched.has(t.path)` comparison against GitHub's own
  // unescaped path, silently failing this guard OPEN on exactly the files
  // its own quoting made unmatchable. `-z` NUL-delimits every entry with no
  // quoting at all, so the split is exact regardless of what characters a
  // path contains.
  const tracked = await git(
    ["-C", root, "diff", "--no-renames", "--name-only", "-z", since],
    { stderr: "inherit", ...definedFields({ timeoutSec }) },
  );
  if (tracked.code !== 0) return null;
  const untracked = await git(
    ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"],
    { stderr: "inherit", ...definedFields({ timeoutSec }) },
  );
  if (untracked.code !== 0) return null;
  const all = `${tracked.stdout}\0${untracked.stdout}`
    .split("\0")
    .filter((f) => f !== "");
  return [...new Set(all)].sort();
}

/**
 * Every file THIS ROUND'S OWN commits touched since `since` — tracked
 * (`git log --no-merges --name-only <since>..HEAD ^origin/<base>`) unioned
 * with untracked, exactly as `changedFilesSince` unions them — or `null`
 * when any read fails.
 *
 * Why a separate function: `changedFilesSince(root, since)` diffs `since`
 * against the working tree directly, so it includes every file a base-sync
 * merge (SKILL.md § 5 runs `base-sync.ts` every round before pushing) brought
 * in from `origin/<base>` along the way — not just what this round's own
 * commits touched. `finish-round.ts`'s untriaged-thread guard's own doc
 * comment claims it fires on "this round's own file changes"; that claim was
 * false whenever a base-sync merge landed since `since`, because the merge's
 * entire imported delta silently counted as "touched by this round".
 *
 * `lib/metrics.ts`'s `sizeOf` already measured the size of this class of error
 * on real data: one base-sync merge commit on one PR contributed +52,015 of
 * that PR's 52,442 post-review additions, on a PR whose entire net diff was 222
 * lines (see that file's own comment). `sizeOf` fixes it by excluding merge
 * commits (`parents >= 2`) from a GitHub PR commit sample that ALREADY excludes
 * anything an ancestor of the PR's base — a population this module does not
 * have. Working from raw local git history instead, `--no-merges` alone is not
 * enough: `since..HEAD` still lists every individual (non-merge) commit
 * `origin/<base>` itself contributed, because those commits are not ancestors
 * of `since` even though they ARE ancestors of `origin/<base>`.
 * `^origin/<base>` closes that gap — it excludes every commit reachable from
 * the current `origin/<base>` tip, whichever side of the merge it arrived from,
 * leaving only commits genuinely authored on this branch since `since`.
 *
 * `git log`'s revision-walk semantics make `<since>..HEAD ^origin/<base>`
 * exact rather than approximate: `A..B` expands to "positive B, negative A",
 * and a trailing `^C` adds C to the same negative set — so the final
 * population is "reachable from HEAD, minus reachable from `since` OR
 * `origin/<base>`", computed in one walk rather than approximated by
 * excluding merge commits and hoping nothing else slipped through.
 *
 * `<base>` is the pull request's own base (`prBaseRef`), not the integration
 * branch. For a stacked layer, a base sync merges in the layer below, whose
 * commits are not on the integration branch yet; excluding only what the
 * integration branch reaches would count them as this round's own.
 */
export async function changedFilesSinceExcludingMerges(
  root: string,
  pr: string,
  since: string,
  timeoutSec?: number,
): Promise<string[] | null> {
  // No base, no exclusion set: fail closed like any other failed read.
  const resolved = await prBaseRef(root, pr, timeoutSec);
  if ("error" in resolved) {
    process.stderr.write(`${resolved.error}\n`);
    return null;
  }
  const ref = resolved.ref;
  // `-c core.quotePath=false` on both reads: `core.quotePath` defaults to true,
  // which backslash-octal-escapes a non-ASCII path in `--name-only`/`ls-files`
  // output. The `touched.has(t.path)` comparison in `finish-round.ts` matches
  // this output against GitHub's own (unescaped, plain-UTF-8) thread path, so a
  // quoted path would silently never match and the guard would fail OPEN on
  // exactly the files its own escaping made unmatchable. `--no-renames` on the
  // `log` call: a rename this round's own commit made (`git mv`) reports only
  // the destination path under rename detection, so a thread still anchored to
  // the pre-rename path would never appear in `touched` and the guard would
  // miss it.
  const own = await git(
    [
      "-C",
      root,
      "-c",
      "core.quotePath=false",
      "log",
      "--no-merges",
      "--no-renames",
      "--name-only",
      "-z",
      "--pretty=format:",
      `${since}..HEAD`,
      `^${ref}`,
    ],
    { stderr: "inherit", ...definedFields({ timeoutSec }) },
  );
  if (own.code !== 0) return null;
  const untracked = await git(
    [
      "-C",
      root,
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { stderr: "inherit", ...definedFields({ timeoutSec }) },
  );
  if (untracked.code !== 0) return null;
  const all = `${own.stdout}\0${untracked.stdout}`
    .split("\0")
    .filter((f) => f !== "");
  return [...new Set(all)].sort();
}

export interface RoundBase {
  /**
   * The base a caller should diff this round's tree against: the verified
   * SHA when it validates, otherwise the CUMULATIVE merge-base (`git
   * merge-base origin/<base> HEAD`). `''` when NEITHER resolves — either
   * the verified SHA is unusable AND the cumulative merge-base itself could
   * not be computed (no `origin/<base>`, an unreadable git state), OR the
   * verified-SHA READ ITSELF failed (`readVerifiedSha` returned `null`,
   * meaning `drive-state.ts verified` exited non-zero) — deliberately
   * without even attempting the cumulative fallback in that case, since a
   * broken state read must fail closed rather than silently substitute a
   * different base. A
   * caller MUST treat `''` as "no base could be established", the same
   * fail-closed posture `changedFilesSince` already takes on its own `null`.
   */
  base: string;
  /** The verified SHA actually used as `base`; `null` when it fell back to the cumulative merge-base (whether or not that fallback itself succeeded). */
  sha: string | null;
  /**
   * Why `sha` is `null`, in the same wording `round-plan.ts`'s own
   * `decayNote` used before this extraction — empty string when `sha` is
   * non-null (nothing to explain). A full clause ending "so the round base
   * falls back to the cumulative merge-base (fail-closed)" — this is
   * `roundBase`'s own subject (a BASE falling back), which is exactly right
   * for `finish-round.ts`'s use of it and exactly wrong for a caller that
   * wants to talk about something else falling back or failing to hold. A
   * caller in that position wants `reason` below, not this field, verbatim.
   */
  note: string;
  /**
   * The bare fragment `note` is built from — e.g. `"no green-verified SHA
   * recorded yet"` or `"recorded verified SHA abc123 is not an ancestor of
   * HEAD (rebased or force-pushed)"` — with no "so X" suffix naming what
   * fell back. Empty string when `sha` is non-null (nothing to explain).
   *
   * Exists so a caller whose OWN subject differs from "the round base" (e.g.
   * `round-plan.ts`'s Testbox-decay block, whose subject is the TESTBOX
   * REQUIREMENT decaying, not a round base falling back) can compose its own
   * sentence — `${rb.reason}, so the requirement cannot decay (fail-closed)`
   * — from the same underlying fact `note` already carries, rather than
   * repeating `note`'s wording under a subject it was never written for.
   */
  reason: string;
}

/**
 * Resolve the base to diff THIS round's local tree against: the last
 * verified SHA, if it is still usable, otherwise the cumulative merge-base
 * against `origin/<base>`.
 *
 * "Usable" is the identical three-check fail-closed chain `round-plan.ts`'s
 * Testbox-decay block runs before trusting a recorded verified SHA as a
 * delta base: it must be RECORDED (a caller that never verified anything has
 * no delta to speak of), it must be a commit THIS CLONE can resolve (a
 * recorded SHA from a clone that has since been pruned or never fetched it),
 * and it must be an ANCESTOR of HEAD (a rebase or force-push leaves the old
 * SHA resolvable via `cat-file -e` while it sits on a history HEAD is no
 * longer on — diffing against it would compare against an unrelated tree).
 * Any one of those failing falls back to the cumulative merge-base, and
 * `note`/`reason` say which.
 */
export async function roundBase(
  root: string,
  pr: string,
  driveStatePath: string,
  timeoutSec?: number,
): Promise<RoundBase> {
  const cumulativeBase = async (reason: string): Promise<RoundBase> => {
    const note = `${reason}, so the round base falls back to the cumulative merge-base (fail-closed)`;
    const resolved = await prBaseRef(root, pr, timeoutSec);
    if ("error" in resolved) {
      return {
        base: "",
        sha: null,
        note: `${note}, and ${resolved.error}`,
        reason,
      };
    }
    const ref = resolved.ref;
    const mb = await git(["-C", root, "merge-base", ref, "HEAD"], {
      stderr: "inherit",
      ...definedFields({ timeoutSec }),
    });
    if (mb.code !== 0) {
      return {
        base: "",
        sha: null,
        note: `${note}, and the cumulative merge-base (${ref} vs HEAD) could not be resolved either`,
        reason,
      };
    }
    return { base: mb.stdout.trim(), sha: null, note, reason };
  };

  const verifiedSha = await readVerifiedSha(pr, driveStatePath, timeoutSec);
  // A FAILED read (`null`) must not fall back to the cumulative base the way
  // a legitimate empty response does: `cumulativeBase()` almost always
  // succeeds (`git merge-base` rarely fails), so silently routing a broken
  // `drive-state.ts verified` read through it would let `checkUntriagedThreads`
  // proceed on a state file it never actually managed to read — exactly the
  // input-read failure this guard's own contract says must fail closed.
  // Return an empty
  // `base` directly, with no `git merge-base` fallback attempt, so the
  // caller's `rb.base === ''` check fires.
  if (verifiedSha === null) {
    return {
      base: "",
      sha: null,
      note: 'drive-state.ts verified exited non-zero — cannot distinguish "no round has verified yet" from "the state read is broken", refusing to guess',
      reason: "the verified-SHA read failed",
    };
  }
  if (verifiedSha === "") {
    return cumulativeBase("no green-verified SHA recorded yet");
  }

  // A corrupted state file can still pass the shape check in `schema.ts`
  // while carrying a symbolic ref (e.g. `HEAD`) instead of a 40-character
  // SHA. `cat-file -e` and
  // `merge-base --is-ancestor` both resolve `HEAD` successfully — it moves
  // WITH the tree they are being asked to validate it against — so the two
  // checks below would pass a value the fail-closed chain exists to reject,
  // and `finish-round.ts`'s subsequent `HEAD..HEAD` walk silently reports no
  // files touched. Reject anything that is not a real SHA before asking git
  // to resolve it at all, same as every other verified-SHA consumer in this
  // skill (`isGitSha` guards it identically in `drive-state.ts` and
  // `finish-round.ts`'s own head check).
  if (!isGitSha(verifiedSha)) {
    return cumulativeBase(
      `recorded verified SHA '${verifiedSha}' is not a 40-character commit SHA`,
    );
  }

  const exists = await git(
    ["-C", root, "cat-file", "-e", `${verifiedSha}^{commit}`],
    { stderr: "ignore", ...definedFields({ timeoutSec }) },
  );
  if (exists.code !== 0) {
    return cumulativeBase(
      `recorded verified SHA ${short(verifiedSha)} is not a commit in this clone`,
    );
  }

  const ancestor = await git(
    ["-C", root, "merge-base", "--is-ancestor", verifiedSha, "HEAD"],
    { stderr: "ignore", ...definedFields({ timeoutSec }) },
  );
  if (ancestor.code !== 0) {
    return cumulativeBase(
      `recorded verified SHA ${short(verifiedSha)} is not an ancestor of HEAD (rebased or force-pushed)`,
    );
  }

  return { base: verifiedSha, sha: verifiedSha, note: "", reason: "" };
}

/**
 * Where the reviewer's own review sits relative to the head an answer names:
 * the question every fix-dependent answer marker is dated by
 * (`summary-findings.ts`' `collectAddressed`).
 */
import { spawnSync } from "node:child_process";

/**
 * Where the reviewer's own reviewed head sits relative to `sha`, the head a
 * fix-dependent marker names.
 *
 * A position rather than a boolean, because `collectAddressed` has to tell a
 * reviewer STRICTLY BEHIND the fix (its review predates the commit, so it
 * cannot have judged it — the marker stands for any finding) from one sitting
 * exactly ON it (it has read that head, which falsifies the answer for a fresh
 * finding but not for a carried-forward backlog entry) — and both from
 * everything else.
 *
 * `unknown` is the one value that is NOT a statement about the reviewer at all:
 * it says the MARKER's own SHA resolves to no commit here, so there is nothing
 * to be behind or at. It is separate from `past` only because the winddown
 * exemption ignores position by design, and had to be stopped from ignoring an
 * undated marker with it (`collectAddressed`). Everywhere else the two behave
 * identically — neither is `behind` or `at`, so neither honours a marker on its
 * own.
 *
 * The question is NOT "is `sha` an ancestor of the reviewed head". Asking it
 * that way has only one safe answer and three unsafe ones, because a PR branch
 * can be rebased or force-pushed: the reviewed head then need not descend from
 * the marker's commit at all, `--is-ancestor` says "no", and the marker is read
 * as "the reviewer has not seen this fix yet" — so it keeps suppressing a
 * finding the reviewer is re-emitting on the rewritten branch, which is false
 * convergence by the exact route the expiry exists to close. Ahead, divergent,
 * or unanswerable are therefore one position — `past` — and re-ask the finding.
 * Re-asking costs one round; the alternative costs a live finding.
 *
 * BOTH revisions are resolved through git before anything is compared, and that
 * is a correctness requirement rather than hygiene. `reviewedShaFrom` accepts
 * `[0-9a-f]{7,40}`, so the reviewer may stamp an ABBREVIATED SHA; deciding the
 * equal case by raw string comparison then misses it and falls through to `--is-ancestor`, which exits 0 for two equal
 * commits — reporting the reviewer as strictly behind a fix it is sitting
 * exactly on. Under the `at` grace that would silently extend a backlog-only
 * exemption to every finding, so equality is git's answer, not the string's.
 *
 * `git merge-base --is-ancestor` needs no network, and its exit status carries
 * more than the pass/fail a caller tends to assume:
 *
 *   0     the reviewed head is an ancestor of `sha`, and the two are already
 *         known to differ, so strictly behind. `behind`.
 *   1     it is not: ahead, or divergent after a rewrite. `past`.
 *   ≥2    git could not answer: an unknown SHA, a shallow clone, not a repo.
 *         `past`.
 *
 * Reading a non-zero as `behind` would let every error case retire the finding
 * on the strength of a check that did not run — a shallow CI checkout would
 * silently restore the content-keyed suppression this exists to remove. So an
 * error is `past`, as are a missing reviewed SHA, a reviewed SHA git cannot
 * resolve, and a git that will not spawn; a MARKER SHA git cannot resolve is
 * `unknown`, which is stricter still. Every one of them withholds the marker
 * and blocks convergence.
 */
export type ReviewerPosition = "behind" | "at" | "past" | "unknown";

/** The git executable, resolved once so no spawn depends on a later PATH lookup. */
const GIT = Bun.which("git");

/**
 * Commit ids by repository and revision, shared by every position asked in this
 * process; only a resolved id is kept, since a revision git cannot resolve now
 * may resolve after a fetch.
 */
const commitIds = new Map<string, string>();

// `^{commit}` so a revision that resolves to some other object type is a
// non-answer rather than an id that can never equal a commit's.
function commitId(git: string, rev: string): string | null {
  const key = `${process.cwd()}\0${rev}`;
  const known = commitIds.get(key);
  if (known !== undefined) return known;
  const r = spawnSync(git, ["rev-parse", "--verify", `${rev}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // A signalled or unspawnable child reports a null status, not a number.
  const id = r.status === 0 ? r.stdout.trim() || null : null;
  if (id !== null) commitIds.set(key, id);
  return id;
}

/** Positions by repository and resolved commit pair, compared once per process. */
const positions = new Map<string, ReviewerPosition>();

export function reviewerPosition(
  sha: string,
  reviewedSha?: string,
): ReviewerPosition {
  if (!reviewedSha || !GIT) return "past";
  try {
    const to = commitId(GIT, sha);
    // The MARKER's own SHA not resolving is a different failure from every
    // other one here, and the only one that has to be told apart: the others
    // say "the reviewer's position relative to this fix is unknown", which
    // `past` answers correctly, while this one says the marker names nothing
    // datable AT ALL. The winddown exemption deliberately ignores position —
    // that is its whole point — so folding this case into `past` would hand it
    // an undated marker to honour, contradicting the "never exempt from the
    // dating requirement" contract in `AddressedOptions.winddownDeferred`. A
    // distinct value, checked there.
    if (!to) return "unknown";
    const from = commitId(GIT, reviewedSha);
    if (!from) return "past";
    if (from === to) return "at";
    const key = `${process.cwd()}\0${from}..${to}`;
    const known = positions.get(key);
    if (known !== undefined) return known;
    const { status } = spawnSync(
      GIT,
      ["merge-base", "--is-ancestor", from, to],
      {
        stdio: "ignore",
      },
    );
    // Same null-status reasoning: an answer git did not give must land in
    // `past` like every other unknown here, never be read as the ancestor case.
    const position = status === 0 ? "behind" : "past";
    positions.set(key, position);
    return position;
  } catch {
    return "past";
  }
}

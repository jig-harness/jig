import { definedFields } from "../../../../shared/defined-fields.ts";
/**
 * Has the PR's base branch moved under this drive, and does it matter?
 *
 * The loop never ran `git fetch`. Nothing in it did — the only mention of one
 * anywhere in this skill was the hint `drive.ts` prints on the way out of exit
 * 9 (`PR_CONFLICTING`). So base drift was invisible locally, and the loop
 * learned of it only when GitHub flipped `mergeable` to CONFLICTING, which is
 * the LAST moment it is cheap to act on rather than the first:
 *
 *   - A CONFLICTING PR gets zero `pull_request` CI. GitHub cannot compute the
 *     merge ref, so `pr-quality-gates.yml` never runs — the drive keeps
 *     resolving threads with its required checks dark, and the gap widens for
 *     as long as the drive runs.
 *   - The round's local gates (and any Testbox) validate the branch over a
 *     STALE base, while `pull_request` CI checks out `refs/pull/N/merge` — the
 *     branch merged into the base's CURRENT tip (no job in that workflow
 *     overrides `ref:`). Local green and CI red is therefore a reachable, and
 *     silent, disagreement.
 *   - Conflicts get more expensive the longer they are left, and resolving one
 *     is exactly the intent-tracing work `/jig:resolve-conflicts` owns —
 *     work an unattended round should meet EARLY, while there is still a human
 *     around to park it for, not at the announce gate.
 *
 * What this module deliberately does NOT do is treat "behind" as the trigger.
 * Commits-behind is a proxy; the predicate that tracks both a textual
 * conflict and the semantic breakage class far more reliably is whether the
 * base touched a file this PR also touches. A base that advanced 200 commits
 * without touching one of the PR's files is measured as having nothing to
 * merge in, and a merge that buys nothing is not free: it pushes a new head,
 * which burns a review round against the reviewer's own wind-down ceiling,
 * and it re-arms the expensive validation tier (round-plan.ts decays Testbox
 * on `git diff <verifiedSha>`, two-dot against the worktree — a base merge
 * drops every file the base touched into that delta, which will contain
 * `profile: full` files nearly always). Hence `overlap`, not `behind`, is
 * what the callers act on.
 *
 * File-granularity overlap tracks a textual conflict and the semantic
 * breakage class far more reliably than a raw commit count does, but it is a
 * TRIGGER for the merge attempt, not a proof either way: zero measured
 * overlap does not guarantee the merge applies cleanly (a directory rename,
 * or a conflict git's merge engine surfaces outside the measured path set,
 * can still happen — `base-sync.ts`'s own exit-9 handling accounts for
 * exactly this), any more than overlap guarantees a conflict. It is the
 * cheapest predicate that is right far more often than a clock.
 * Area-granularity overlap (the change-areas catalog)
 * was considered and rejected: `areas` is the fan-in closure, so nearly any
 * two diffs in this repository share an area, which makes the predicate fire
 * constantly and buys back the cadence this exists to avoid.
 *
 * Untracked files count toward the PR side of the overlap for the same reason
 * round-plan.ts counts them in a plan: a round that adds a new file has not
 * committed it yet, and an untracked file colliding with a NEW base file is a
 * merge blocker ("untracked working tree file would be overwritten") exactly
 * like a tracked one.
 *
 * Overlap is not only an exact path match: a directory/file collision (the PR
 * adds `foo/bar.ts` while the base adds a plain file `foo`, or vice versa)
 * shares no path string with an exact-set intersection, yet git cannot
 * construct that merge tree either — see `pathCollisions` below.
 */

import { gitCallTimeoutSeconds, readTimeoutEnv } from "./proc.ts";
import { repoOfUrl } from "./repo-url.ts";

/** The measurement. Counts are uncapped; `overlap` is a bounded SAMPLE. */
export interface BaseDrift {
  /** The base branch, as a remote-tracking ref: `origin/develop`. */
  baseRef: string;
  /** merge-base(baseRef, HEAD) — the fork point, which drift never moves. */
  mergeBase: string;
  /** Commits the base has gained since the fork point. */
  behind: number;
  /** Files this PR changes (tracked diff since the fork point + untracked). */
  prFiles: number;
  /** Files the base changed since the fork point. */
  baseFiles: number;
  /** How many files are in BOTH sets — the predicate callers act on. */
  overlapCount: number;
  /** Up to `OVERLAP_SAMPLE` of them, sorted. Evidence, not the count. */
  overlap: string[];
  /**
   * Did the `git fetch` that preceded this measurement succeed? `false` means
   * every number here was read off a remote-tracking ref of unknown age, so a
   * zero is "nothing KNOWN to have changed" rather than "nothing changed".
   */
  fetched: boolean;
}

/** Enough to recognise the drift; not so many that a round's log is a diff. */
export const OVERLAP_SAMPLE = 10;

export type DriftVerdict = "in-sync" | "no-overlap" | "overlapping";

/**
 * Only `overlapping` is worth a merge. `no-overlap` is a positive answer —
 * the base moved and cannot have moved under this PR — not a degraded one.
 */
export function driftVerdict(d: BaseDrift): DriftVerdict {
  if (d.behind === 0) return "in-sync";
  return d.overlapCount > 0 ? "overlapping" : "no-overlap";
}

/**
 * One line for a round's narration, or `null` when there is nothing to say.
 *
 * `in-sync` prints nothing on purpose: a line on every round for the state
 * that needs no action is how a warning stops being read. An unfetched
 * measurement is always worth a line, because its silence is the untrustworthy
 * kind.
 */
export function driftLine(d: BaseDrift): string | null {
  const verdict = driftVerdict(d);
  const stale = d.fetched ? "" : " (fetch FAILED — read off a stale local ref)";
  if (verdict === "in-sync") {
    return d.fetched
      ? null
      : `BASE: cannot confirm ${d.baseRef} is current${stale}`;
  }
  if (verdict === "no-overlap") {
    return (
      `BASE: ${d.baseRef} is ${d.behind} commit(s) ahead, but touches none of this PR's ` +
      `${d.prFiles} file(s)${stale} — nothing to merge in`
    );
  }
  const sample = d.overlap.join(", ");
  const more =
    d.overlapCount > d.overlap.length
      ? `, +${d.overlapCount - d.overlap.length} more`
      : "";
  return (
    `BASE: ${d.baseRef} is ${d.behind} commit(s) ahead and overlaps ${d.overlapCount} of ` +
    `this PR's file(s)${stale}: ${sample}${more}\n` +
    "  Merge it in as part of this round, BEFORE resolving the validation plan:\n" +
    "    <skill-dir>/scripts/base-sync.ts [PR]"
  );
}

/**
 * `$DRIVE_PR_FETCH_TIMEOUT`. Its own knob rather than `GH_CALL_TIMEOUT` or
 * `GIT_CALL_TIMEOUT`, following `guarded-push.ts`'s `DRIVE_PR_PUSH_TIMEOUT`:
 * this call also reaches the network, and `proc.ts`'s `git()` is undeadlined
 * by default precisely so a caller that reaches the network has to say so.
 * Unbounded it is mode 13 in terminal-states.md — a connection accepted and
 * never completed parks an unattended driver past every advertised deadline.
 */
export function fetchTimeoutSeconds(): ReturnType<typeof readTimeoutEnv> {
  return readTimeoutEnv("DRIVE_PR_FETCH_TIMEOUT", 120);
}

/**
 * The git seam. Every call this module makes goes through it, so a test can
 * drive the whole probe off a fixture without a repository — the same
 * injected-deps shape `round-plan.ts`'s `loadWarningLine` uses for
 * `checkLoad()`.
 */
export type GitRunner = (
  args: string[],
  opts?: { timeoutSec?: number; env?: Record<string, string | undefined> },
) => Promise<{
  code: number;
  stdout: string;
}>;

export type DriftProbe =
  | { ok: true; drift: BaseDrift }
  | { ok: false; why: string };

function lines(s: string): string[] {
  return s.split("\n").filter((l) => l !== "");
}

/**
 * Every proper ancestor directory a set of paths implies. `"foo/bar.ts"`
 * implies `"foo"`; a flat path implies nothing.
 */
function impliedDirectories(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }
  return dirs;
}

/**
 * Exact-path intersection misses a directory/file collision: the PR adding
 * `foo/bar.ts` while the base adds a plain file `foo` (or vice versa) shares
 * no path string, so a set intersection reports zero overlap — yet git cannot
 * construct the merge tree, and `no-overlap` would skip the merge that could
 * have surfaced that early. A path one side's
 * diff implies is a DIRECTORY and the other side's diff touches as a FILE is
 * exactly that collision, in either direction.
 */
function pathCollisions(prSet: Set<string>, baseSet: Set<string>): string[] {
  const prDirs = impliedDirectories(prSet);
  const baseDirs = impliedDirectories(baseSet);
  const collisions = new Set<string>();
  for (const dir of prDirs) if (baseSet.has(dir)) collisions.add(dir);
  for (const dir of baseDirs) if (prSet.has(dir)) collisions.add(dir);
  return [...collisions];
}

/**
 * Does the local `origin` remote's FETCH url actually point at the
 * repository this PR belongs to? `probeBaseDrift` always fetches
 * `origin +refs/heads/<base>:refs/remotes/origin/<base>` — correct whenever
 * `origin` IS that repository, which is every ordinary same-repo clone, but
 * silently wrong whenever it is not: a fork PR driven from a clone of the
 * fork (`origin` = the fork, not the PR's own repository), or the `gh`/git
 * disagreement `guarded-push.ts`'s own head-side guard exists for
 * (`$GH_REPO`, `gh repo set-default`). `git fetch` cannot detect this itself
 * — it happily writes `refs/remotes/origin/<base>` from whatever `origin`
 * answers with, under the name the caller asked for, so a wrong-repository
 * fetch reads exactly like a right one. This check has to run BEFORE that
 * fetch, using the identical `owner/name` extraction `guarded-push.ts` checks
 * the push side with — the same reachable failures, the opposite side of one
 * PR.
 *
 * `expectedRepo` is `owner/name` for the repository the caller already knows
 * `gh` resolved this PR against — GitHub has no per-PR "base repository"
 * field, since a PR's base is by definition whatever repository it was filed
 * against, so both callers read it the same way: `gh repo view --json
 * owner,name` (`base-sync.ts`'s own call, or `drive-status.ts`'s pre-existing
 * one). This function does no `gh` I/O of its own, keeping this module's
 * dependency surface local-git-only.
 */
export async function verifyOriginIsPrRepo(
  git: GitRunner,
  root: string,
  expectedRepo: string,
  env?: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const urlRes = await git(["-C", root, "remote", "get-url", "origin"], {
    timeoutSec: gitCallTimeoutSeconds(),
    ...definedFields({ env }),
  });
  if (urlRes.code !== 0 || urlRes.stdout.trim() === "") {
    return { ok: false, why: "no fetch URL for the remote 'origin'" };
  }
  const url = urlRes.stdout.trim();
  const actual = repoOfUrl(url);
  // GitHub repository paths are case-insensitive (and ASCII-only, so a plain
  // `toLowerCase()` is length-preserving and safe here) — an `origin` whose
  // configured URL casing differs from `gh`'s canonical `owner/name` is the
  // SAME repository, not a mismatch.
  if (actual === "" || actual.toLowerCase() !== expectedRepo.toLowerCase()) {
    return {
      ok: false,
      why:
        actual === ""
          ? `cannot parse an owner/name out of origin's fetch URL (${url})`
          : `'origin' fetches ${actual} (${url}), not this PR's own repository ${expectedRepo} — refusing to fetch or measure its base branch from the wrong history`,
    };
  }
  return { ok: true };
}

/**
 * Is this checkout actually the PR's own head — not merely a descendant of
 * it? `origin` fetching the right REPOSITORY (above) does not prove this
 * WORKTREE is checked out on the PR's own branch: invoked with an explicit PR
 * from an unrelated branch or worktree, or from a sibling branch created
 * from, or later merged with, the PR's head, the ancestor check alone would
 * pass — `apiHead` is an ancestor of the sibling's HEAD too — and publish
 * that sibling branch's files and overlap as the requested PR's drift
 *. The branch-name check catches exactly
 * that case; the ancestor check on top of it still matters, since a same-
 * named unrelated local branch would pass the name check alone.
 *
 * `--is-ancestor` accepts equality — a commit is its own ancestor — so this
 * passes both when local `HEAD` *is* the PR's head and when it carries
 * genuine local commits on top of it, and refuses whenever the relationship
 * cannot be established (a diverged branch, or an object this worktree never
 * fetched at all).
 */
export async function verifyCheckoutIsPrHead(
  git: GitRunner,
  root: string,
  headRefName: string,
  apiHead: string,
  env?: Record<string, string | undefined>,
): Promise<{ ok: true } | { ok: false; why: string }> {
  const branchRes = await git(
    ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    {
      timeoutSec: gitCallTimeoutSeconds(),
      ...definedFields({ env }),
    },
  );
  if (branchRes.code !== 0) {
    return {
      ok: false,
      why: "cannot read this worktree's current branch",
    };
  }
  const branch = branchRes.stdout.trim();
  if (branch !== headRefName) {
    return {
      ok: false,
      why: `checked out on ${branch === "HEAD" ? "a detached HEAD" : `'${branch}'`}, not this PR's head branch '${headRefName}'`,
    };
  }
  const ancestorRes = await git(
    ["-C", root, "merge-base", "--is-ancestor", apiHead, "HEAD"],
    {
      timeoutSec: gitCallTimeoutSeconds(),
      ...definedFields({ env }),
    },
  );
  if (ancestorRes.code !== 0) {
    return {
      ok: false,
      why: `HEAD is not '${apiHead}' or a descendant of it`,
    };
  }
  return { ok: true };
}

/**
 * Fetch the base, then measure. Fetch failure is NOT probe failure — a report
 * that disappears when the network hiccups is a report nobody can rely on — it
 * is recorded in `fetched` and carried into every line this module prints.
 * An unresolvable merge-base IS probe failure: without the fork point there is
 * no measurement to degrade, only a wrong one.
 */
export async function probeBaseDrift(
  git: GitRunner,
  root: string,
  baseBranch: string,
  fetchSeconds: number,
  env?: Record<string, string | undefined>,
): Promise<DriftProbe> {
  // Only `fetch` talks to a remote and carries the caller's network deadline.
  // Everything below is LOCAL, but "local" is not "instant": a stalled
  // filesystem or a lock another process is holding can hang `merge-base` /
  // `rev-list` / `diff` / `ls-files` exactly as an unresponsive API hangs
  // `gh` — the same reasoning `gitCallTimeoutSeconds()`'s own doc comment
  // gives — and an undeadlined local call here parks the unattended driver
  // just as surely as an undeadlined network one.
  //
  // `env` is optional and forwarded to every call below: a leaked
  // `GIT_DIR`/`GIT_WORK_TREE` pair (a lefthook hook exports both) makes `-C
  // root` alone insufficient — git resolves the location vars first — so the
  // caller-sanitized env has to reach `fetch`, `merge-base`, `rev-list`,
  // `diff` and `ls-files` alike, not just the `-C root` argument
  //. A caller with no leak to guard against (no
  // hook env in play) simply omits it.
  const localTimeoutSec = gitCallTimeoutSeconds();
  const baseRef = `origin/${baseBranch}`;
  // An explicit `+src:dst` refspec, not a plain branch name: a plain name
  // resolves through `origin`'s OWN configured `remote.origin.fetch`, so a
  // narrowed or otherwise non-default mapping can let this exit 0 having
  // updated some ref other than `refs/remotes/origin/<baseBranch>` — the
  // exact ref `baseRef` above reads every measurement below from. Forcing the
  // destination here makes success mean what every caller already assumes it
  // means: `origin/<baseBranch>` was actually refreshed
  //. `baseBranch` cannot smuggle a second
  // `:` into this refspec: `base-sync.ts` runs it through `git
  // check-ref-format --branch` when it comes from `--base`, and git branch
  // names — which is all a colon-free ref name can be — never contain a `:`
  // in the first place when it comes from GitHub's own `baseRefName`.
  const fetched = await git(
    [
      "-C",
      root,
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ],
    {
      timeoutSec: fetchSeconds,
      ...definedFields({ env }),
    },
  );

  const mb = await git(["-C", root, "merge-base", baseRef, "HEAD"], {
    timeoutSec: localTimeoutSec,
    ...definedFields({ env }),
  });
  if (mb.code !== 0 || mb.stdout.trim() === "") {
    return {
      ok: false,
      why: `cannot resolve merge-base against ${baseRef}${
        fetched.code === 0 ? "" : " (and the fetch failed)"
      }`,
    };
  }
  const mergeBase = mb.stdout.trim();

  const behindRes = await git(
    ["-C", root, "rev-list", "--count", `${mergeBase}..${baseRef}`],
    {
      timeoutSec: localTimeoutSec,
      ...definedFields({ env }),
    },
  );
  if (behindRes.code !== 0)
    return { ok: false, why: `cannot count commits on ${baseRef}` };
  // `Number.parseInt` stops at the first non-digit rather than rejecting the
  // rest of the string, so a malformed subprocess response like `2garbage`
  // silently becomes `2`, and a sign-only string like `-1` still passes
  // `Number.isFinite` — both read as a normal drift verdict instead of the
  // failed probe they actually are. `git rev-list
  // --count` only ever emits a bare non-negative decimal integer, so anything
  // else is the subprocess answering unreliably, not a value to coerce.
  const behindRaw = behindRes.stdout.trim();
  if (!/^\d+$/.test(behindRaw)) {
    return {
      ok: false,
      why: `unreadable commit count for ${baseRef}: '${behindRaw}'`,
    };
  }
  const behind = Number.parseInt(behindRaw, 10);

  const prTracked = await git(
    ["-C", root, "diff", "--no-renames", "--name-only", mergeBase],
    {
      timeoutSec: localTimeoutSec,
      ...definedFields({ env }),
    },
  );
  if (prTracked.code !== 0)
    return { ok: false, why: "cannot list this PR's changed files" };
  const prUntracked = await git(
    ["-C", root, "ls-files", "--others", "--exclude-standard"],
    {
      timeoutSec: localTimeoutSec,
      ...definedFields({ env }),
    },
  );
  if (prUntracked.code !== 0)
    return { ok: false, why: "cannot list untracked files" };

  const baseChanged = await git(
    ["-C", root, "diff", "--no-renames", "--name-only", mergeBase, baseRef],
    {
      timeoutSec: localTimeoutSec,
      ...definedFields({ env }),
    },
  );
  if (baseChanged.code !== 0) {
    return { ok: false, why: `cannot list the files ${baseRef} changed` };
  }

  const prSet = new Set([
    ...lines(prTracked.stdout),
    ...lines(prUntracked.stdout),
  ]);
  const baseSet = new Set(lines(baseChanged.stdout));
  const overlapAll = [
    ...new Set([
      ...[...prSet].filter((f) => baseSet.has(f)),
      ...pathCollisions(prSet, baseSet),
    ]),
  ].sort();

  return {
    ok: true,
    drift: {
      baseRef,
      mergeBase,
      behind,
      prFiles: prSet.size,
      baseFiles: baseSet.size,
      overlapCount: overlapAll.length,
      overlap: overlapAll.slice(0, OVERLAP_SAMPLE),
      fetched: fetched.code === 0,
    },
  };
}

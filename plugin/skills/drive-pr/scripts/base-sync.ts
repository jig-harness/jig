#!/usr/bin/env bun
/**
 * Merge the PR's base branch into this round — when, and only when, doing so
 * costs no round the drive would not otherwise have spent.
 *
 * The rule this mechanizes is a PIGGYBACK, not a cadence. "Pull from develop
 * occasionally to keep the branch fresh" sounds cheap and is not: every base
 * merge pushes a new head, which triggers a fresh reviewer round against the
 * reviewer's own wind-down ceiling, and it re-arms the expensive validation
 * tier (see lib/base-drift.ts for the Testbox-decay mechanics). A merge that
 * rides a round which was pushing a commit anyway costs neither. So every
 * precondition below is necessary:
 *
 *   1. the base has actually advanced;
 *   2. it advanced over a file THIS PR also touches (`lib/base-drift.ts`
 *      argues why overlap, not commits-behind, is the predicate);
 *   3. this round is already going to push — an uncommitted change in the
 *      worktree, or a local commit GitHub's own record of the PR does not
 *      have yet.
 *
 * Miss any one and this exits 0 having changed nothing, naming which. That is
 * the common case and it is not a failure. The fetch-freshness gate governs
 * the merge unconditionally, `--force` included: the drift measurement behind
 * it must come from a fetch that actually succeeded (`reason: "fetch-failed"`)
 * — a stale `origin/<base>` can both overlap and miss a real divergence, and
 * merging it would report success without having synchronized anything.
 *
 * `--force` drops 2 and 3 (never 1 or the fetch-freshness gate — merging a
 * base that has not moved, or that this measurement cannot vouch for, is not
 * something a flag should override). It exists for the case the loop cannot
 * see: a human who knows the drive is about to converge and wants the local
 * gates and the `refs/pull/N/merge` CI checkout to agree first.
 *
 * Before any of that, the checkout itself is verified against the PR: an
 * explicit PR argument that disagrees with `$DRIVE_PR_TARGET`, or a worktree
 * not actually sitting on the named PR's head branch, refuses rather than
 * merging the named PR's base into whatever HEAD happens to be and reporting
 * success against a PR it never touched.
 *
 * WHAT IT NEVER DOES is leave the worktree mid-merge. A merge that does not
 * apply cleanly is aborted, the abort is VERIFIED, and the exit says so (9) —
 * an unattended driver resolving conflicts on its own would be doing the
 * intent-tracing work `resolving-merge-conflicts` exists to keep deliberate.
 * If the abort itself fails, that is exit 3 with the marker named, never a
 * quiet exit 9 over a wedged tree.
 *
 * Usage: base-sync.ts [PR] [--check] [--json] [--force] [--base BRANCH]
 *
 *   --check        measure and report; never merge, commit, or push. Exits 0
 *                  whatever the VERDICT — including on a PR that is no longer
 *                  open, since a report that refuses on one of the states it
 *                  exists to describe is one every caller has to special-case.
 *                  This mode DOES still run `git fetch`, refreshing the local
 *                  remote-tracking ref `origin/<base>` — a routine, idempotent
 *                  read-refresh with no effect on the PR, the branch, or this
 *                  worktree's tracked content (docomply-review, a reference-implementation pull request). It
 *                  still refuses on an unreadable INPUT, never a verdict: an
 *                  unconcluded git operation (3), since every diff below
 *                  would compare against a working tree that still holds the
 *                  whole incoming operation; or a checkout
 *                  that is not the named PR's own head branch (1/2), since
 *                  the drift measurement reads THIS checkout's HEAD and a
 *                  mismatched one would report a hybrid mislabeled with the
 *                  requested PR's number.
 *   --json         emit the structured report on stdout instead of prose
 *   --force        merge whenever the base has advanced, skipping the overlap
 *                  and already-pushing preconditions. Say why when you use it.
 *   --base BRANCH  override the base branch. Default: the PR's own
 *                  `baseRefName`, never a hardcoded `develop` — a script that
 *                  bakes the repo's branch rule in merges the wrong branch the
 *                  first time a PR does not follow it.
 *
 * Exit codes:
 *
 *   0  Nothing to do (and which precondition was missing), or merged cleanly.
 *      `--json`'s `action` says which; do not infer it from the code.
 *   2  Usage: an unknown flag, an extra argument, no PR resolvable, a
 *      malformed $DRIVE_PR_FETCH_TIMEOUT, an explicit PR that disagrees with
 *      $DRIVE_PR_TARGET, or a checkout that is not the named PR's own head
 *      branch — checked once up front and RE-CHECKED immediately before the
 *      merge, since the fetch and the tree-lock wait in between can leave
 *      another session's `git checkout`/`git reset` in this same tree
 *      (something the lock does not fence) stale by the time this reaches
 *      the merge.
 *   3  Refused before touching anything: an unconcluded merge/cherry-pick/
 *      revert/rebase/am was already sitting in this worktree, local changes
 *      stood in the merge's way, or an abort could not be verified. Nothing
 *      was merged. The message names which. For the middle one: validate the
 *      current (dirty) tree and commit it, THEN re-run — never commit merely
 *      to unblock this merge without having validated first.
 *   5  The PR is not OPEN. Merging its base into the branch is a mutation a
 *      round is not entitled to make on a PR that already finished — the same
 *      liveness posture finish-round.ts takes before its push. Checked once up
 *      front and RE-CHECKED immediately before the merge, since the fetch and
 *      the tree-lock wait in between are long enough for the PR to close.
 *   9  The merge does not apply cleanly. The worktree is RESTORED. Hand it to
 *      the `resolving-merge-conflicts` skill: intent-traced hunks,
 *      regenerate-don't-hand-merge for generated artifacts, then this round's
 *      own validation plan (SKILL.md § 5), then push.
 *  11  This working tree's TREE lease is held by another live
 *      session — the identical guard `guarded-push.ts` takes before its own
 *      mutation, so two writers in one tree cannot cross-ship uncommitted
 *      state through this merge either; see `lib/state/lease.ts`'s
 *      `assertTreeMutationAllowed`. Never taken under `--check`, which merges
 *      nothing.
 *   1  A step failed. Read its diagnostic.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BaseDrift,
  type DriftVerdict,
  driftLine,
  driftVerdict,
  fetchTimeoutSeconds,
  type GitRunner,
  probeBaseDrift,
  verifyOriginIsPrRepo,
} from "./lib/base-drift.ts";
import { fail, runMain } from "./lib/cli.ts";
import { cachedRepoView } from "./lib/gh-conditional.ts";
import {
  ghCall,
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  resolvePr,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import {
  assertTreeMutationAllowed,
  resolveFenceContext,
} from "./lib/state/lease.ts";

type Action = "none" | "merged";

type Reason =
  | "in-sync"
  | "no-overlap"
  | "nothing-to-piggyback"
  | "fetch-failed"
  | "merged"
  | "check-only";

interface Report {
  pr: number | null;
  action: Action;
  /** Which precondition decided it. Stable strings; `action` alone is coarse. */
  reason: Reason;
  drift: BaseDrift | null;
  mergeCommit: string | null;
}

/**
 * The `reason` for a report that decides nothing further — pure, so the
 * precedence is one reviewable place instead of threaded through `main()`'s
 * control flow. An unverified measurement always outranks a positive
 * verdict, `--check` aside: `verdict` is computed from `behind`/`overlapCount`
 * alone, with no notion of whether the fetch that produced them succeeded, so
 * a stale `origin/<base>` that happens to compute `in-sync` or `no-overlap`
 * must not be reported as a confirmed positive — the report contract
 * documents `fetch-failed` as this measurement's own reason, and a caller
 * checking the top-level `reason` rather than `drift.fetched` deserves that
 * label (docomply-review, a reference-implementation pull request round 8: the verdict branches used to
 * return before the `fetched` check ever ran).
 *
 * Returns `null` when nothing here decides the outcome — the caller must
 * still weigh `alreadyPushing()` and attempt the merge.
 */
export function resolveReadReason(
  check: boolean,
  verdict: DriftVerdict,
  fetched: boolean,
  force: boolean,
): Exclude<Reason, "nothing-to-piggyback" | "merged"> | null {
  if (check) return "check-only";
  if (!fetched) return "fetch-failed";
  if (verdict === "in-sync") return "in-sync";
  if (verdict === "no-overlap" && !force) return "no-overlap";
  return null;
}

/** The subset of `ghCall`'s signature this file's own re-verification needs. */
export type GhRunner = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;

export type StillCurrentResult =
  | { ok: true }
  | { ok: false; code: number; why: string };

/**
 * Re-verify liveness and checkout identity immediately before the one
 * irreversible act (`git merge`) — both were already checked once, well
 * before this point: liveness up front, identity before the fetch. The fetch
 * itself, plus the tree-lock wait that follows (documented as potentially
 * five minutes), are long enough for either read to go stale. The lock only
 * fences OTHER `assertTreeMutationAllowed` callers — an ad hoc `git
 * checkout`/`git reset` by another session in this same tree is not fenced
 * by it at all — and it says nothing about GitHub's own state, so a PR that
 * closed during the wait must not have its base merged into the now-orphaned
 * branch (the exit-5 mutation guard this script otherwise upholds), and a
 * checkout that moved onto a different branch or commit must not be merged
 * into as if it were still this PR's own head (docomply-review, a reference-implementation pull request).
 */
export async function verifyStillCurrent(
  git: GitRunner,
  ghCallFn: GhRunner,
  root: string,
  pr: string,
  headRef: string,
  headOid: string,
  env?: Record<string, string | undefined>,
): Promise<StillCurrentResult> {
  const liveness = await ghCallFn(["pr", "view", pr, "--json", "state"]);
  if (liveness.code !== 0) {
    return {
      ok: false,
      code: 1,
      why: `cannot re-verify PR #${pr}'s liveness immediately before merging`,
    };
  }
  let meta: { state?: string };
  try {
    meta = JSON.parse(liveness.stdout) as typeof meta;
  } catch {
    return {
      ok: false,
      code: 1,
      why: `PR #${pr} returned unparseable JSON re-verifying liveness`,
    };
  }
  if (meta.state !== "OPEN") {
    return {
      ok: false,
      code: 5,
      why: `PR #${pr} is ${meta.state ?? "unreadable"}, not OPEN — refusing to merge its base into this branch`,
    };
  }

  const branchRes = await git(
    ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    {
      env,
    },
  );
  if (branchRes.code !== 0) {
    return {
      ok: false,
      code: 1,
      why: "cannot re-read this worktree's current branch immediately before merging",
    };
  }
  if (branchRes.stdout.trim() !== headRef) {
    return {
      ok: false,
      code: 2,
      why: `this worktree moved off PR #${pr}'s head branch '${headRef}' while waiting for the tree lock — refusing to merge.`,
    };
  }

  const ancestorRes = await git(
    ["-C", root, "merge-base", "--is-ancestor", headOid, "HEAD"],
    { env },
  );
  if (ancestorRes.code !== 0) {
    return {
      ok: false,
      code: 2,
      why: `this worktree's HEAD is no longer PR #${pr}'s reported head commit ${headOid.slice(0, 12)} or a descendant of it — it moved while waiting for the tree lock. Refusing to merge.`,
    };
  }

  return { ok: true };
}

/** `ok: false` means the question could not be answered at all — see below. */
export type PushingProbe =
  | { ok: true; pushing: boolean }
  | { ok: false; why: string };

/**
 * Is this round going to push regardless? Either is enough, independently:
 * work sitting uncommitted in the tree, or a local commit GitHub does not
 * have yet.
 *
 * Satisfying this via the uncommitted-tree branch does not, by itself, land a
 * merge: `main()`'s own dirty-worktree check further down refuses to run
 * `git merge` over anything but a clean tree (starting a merge over dirty
 * state is unsafe — see that check's own comment), so a round with nothing
 * but uncommitted changes always ends this call in exit 3, never
 * `action: "merged"` — SKILL.md § 5's exit-3 row documents the recovery:
 * validate the current (dirty) tree and commit it, THEN re-run this script;
 * never commit merely to unblock the merge without having validated first
 * (a dirty tree from this round's own fixes is exactly the complete change
 * AGENTS.md § Change-Proportional Validation's own resolve command already
 * covers — an uncommitted diff is not an excuse to skip it). This predicate
 * only decides whether attempting the merge is worth the try, not whether an
 * uncommitted-only attempt will succeed (docomply-review, a reference-implementation pull request).
 *
 * The local-commit check compares local `HEAD` against the PR's own `headRefOid` —
 * the SHA GitHub reports for the PR, read alongside `headRefName` in the same
 * call `main()` already makes — rather than a local `origin/<headRef>`
 * remote-tracking ref. That ref is not a reliable stand-in for the PR's
 * remote head: a fork PR's head branch lives in another repository entirely,
 * so `origin/<headRef>` is either absent or names an unrelated branch, and
 * even for a same-repository PR this script never fetches the head branch —
 * only the base — so a cached `origin/<headRef>` can be stale. Both a missing
 * ref and a stale one previously read as "unreadable", which the caller used
 * to treat as "yes, pushing", creating a base merge with nothing to piggyback
 * on exactly the round this predicate exists to spare. Comparing against the
 * SHA GitHub itself just reported has no such blind spot.
 *
 * `ok: false` means the question could not be answered — `git status` or
 * `git rev-parse HEAD` itself failed to run, or the PR reported no
 * `headRefOid` to compare against. The caller REFUSES on this rather than
 * guessing either way: guessing "yes, pushing" on a genuine subprocess
 * failure can create a standalone merge commit and spend the reviewer/Testbox
 * cycle this piggyback predicate exists to avoid, and guessing "no" would
 * silently skip the sync on every round of a drive whose local HEAD this
 * clone cannot read. Both guesses hide the same underlying fact — that this
 * read did not work — behind an answer that looks like a normal verdict; a
 * loud refusal surfaces it instead (docomply-review, a reference-implementation pull request).
 */
export async function alreadyPushing(
  git: GitRunner,
  root: string,
  headOid: string,
  env?: Record<string, string | undefined>,
): Promise<PushingProbe> {
  const timeoutSec = gitCallTimeoutSeconds();
  // `--untracked-files=normal` and `--ignore-submodules=none` are explicit,
  // not decorative: a plain `--porcelain` inherits `status.showUntrackedFiles`
  // from repo/user config and `submodule.<name>.ignore` from `.gitmodules`,
  // either of which can make a round with real new files or submodule changes
  // read as `pushing: false` here and skip a sync it owed
  // (chatgpt-codex-connector, a reference-implementation pull request — the same class `announce-merge-ready.ts`
  // already hardens against).
  const status = await git(
    [
      "-C",
      root,
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    {
      timeoutSec,
      env,
    },
  );
  if (status.code !== 0) {
    return {
      ok: false,
      why: "cannot read this worktree's status (git status failed)",
    };
  }
  if (status.stdout.trim() !== "") return { ok: true, pushing: true };

  if (headOid === "") {
    return {
      ok: false,
      why: "the PR reported no headRefOid to compare local HEAD against",
    };
  }
  const head = await git(["-C", root, "rev-parse", "HEAD"], {
    timeoutSec,
    env,
  });
  if (head.code !== 0) {
    return {
      ok: false,
      why: "cannot read this worktree's HEAD (git rev-parse failed)",
    };
  }
  const sha = head.stdout.trim();
  if (sha === "") {
    return { ok: false, why: "git rev-parse HEAD returned no output" };
  }
  return { ok: true, pushing: sha !== headOid };
}

/**
 * Is the worktree itself clean — not just `HEAD` sitting where it should?
 * `git merge --abort` and `git reset --hard` both restore tracked files and
 * the index, but neither removes an UNTRACKED file a failed merge attempt's
 * own side effects can leave behind (a hook writing a build artifact, a
 * merge driver's byproduct). `main()` calls this only after already
 * confirming the worktree was fully clean immediately before the merge was
 * attempted (its own dirty-tree refusal, ahead of the `git merge` call), so
 * ANY status output here now is new — proof the worktree was not actually
 * restored, not merely unconfirmed (docomply-review, a reference-implementation pull request).
 */
export async function worktreeClean(
  git: GitRunner,
  root: string,
  env?: Record<string, string | undefined>,
): Promise<boolean> {
  const status = await git(
    [
      "-C",
      root,
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    {
      timeoutSec: gitCallTimeoutSeconds(),
      env,
    },
  );
  return status.code === 0 && status.stdout.trim() === "";
}

async function main(): Promise<number> {
  let pr = "";
  let check = false;
  let json = false;
  let force = false;
  let baseOverride = "";

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    switch (a) {
      case "--check":
        check = true;
        break;
      case "--json":
        json = true;
        break;
      case "--force":
        force = true;
        break;
      case "--base": {
        const v = argv[++i];
        if (v === undefined || v === "" || v.startsWith("-")) {
          fail(2, "base-sync: --base needs a branch name");
        }
        baseOverride = v;
        break;
      }
      default:
        if (a.startsWith("-")) fail(2, `base-sync: unknown flag '${a}'`);
        if (pr !== "") fail(2, `base-sync: unexpected extra argument '${a}'`);
        if (!/^[0-9]+$/.test(a))
          fail(2, `base-sync: '${a}' is not a PR number`);
        pr = a;
    }
  }

  const fetchSec = fetchTimeoutSeconds();
  if (!fetchSec.ok) {
    fail(
      2,
      `base-sync: DRIVE_PR_FETCH_TIMEOUT must be a positive whole number of seconds (got '${fetchSec.raw}')`,
    );
  }

  const gitTimeout = gitCallTimeoutSeconds();
  /**
   * Scrubbed once and reused for every git call this script makes, not just
   * the fetch: a leaked `GIT_DIR`/`GIT_WORK_TREE` overrides repository
   * discovery regardless of `-C`, so every operation below — not only the one
   * that talks to the network — needs it.
   *
   * The derivation is `lib/proc.ts`'s, imported rather than restated. The old
   * convention here was one private copy per script "to keep its dependency on
   * git plumbing self-contained", and the cost of it was measured: four copies
   * existed, two of them missing `GIT_NAMESPACE` AND the Windows case-folding
   * that PR #4124 rounds 3-4 had already found and fixed on the other two. A
   * fix that does not reach the siblings of the file it landed on is the
   * defect.
   *
   * What the scrub buys HERE specifically, beyond the shared rationale in
   * `lib/proc.ts`: `GIT_DIR` alone — no `GIT_WORK_TREE` — makes git treat the
   * CURRENT DIRECTORY as the work tree while still resolving refs from the
   * leaked dir, so `-C root` keeps pointing at the right FILES while every git
   * OPERATION below silently answers for a different repository. The
   * branch-name and ancestor-of-`headOid` checks below would pass for the
   * leaked repo's own HEAD, and a `git merge` would write refs into it while
   * touching this worktree's files — the "a matching checkout can be measured
   * or merged while the intended worktree remains untouched" failure this
   * file's own reviewer named (docomply-review, a reference-implementation pull request). `-C root` alone was
   * never sufficient against any of these.
   */
  const identityEnv = gitIdentityEnv();

  // `--base` is documented as accepting a branch name, but the earlier
  // empty/leading-dash check does not stop it being a REFSPEC instead of a
  // plain name — `origin/${baseOverride}` degrading to something unreadable
  // is not the first thing that happens with a value like
  // `source:refs/heads/other`. `git fetch origin <that>` (probeBaseDrift's
  // own positional fetch argument below) reads it as `<src>:<dst>` and
  // WRITES `refs/heads/other` locally as a side effect of the fetch, before
  // the constructed ref is ever read back. `check-ref-format --branch` is
  // git's own single-name syntax check — no repository required, and it
  // refuses ':' unconditionally, the same way it already refuses a leading
  // '-' — so validating with it here closes the refspec-injection path
  // before any fetch runs (docomply-review, a reference-implementation pull request).
  if (baseOverride !== "") {
    const refCheck = await git(["check-ref-format", "--branch", baseOverride], {
      stderr: "ignore",
      timeoutSec: gitTimeout,
      env: identityEnv,
    });
    if (refCheck.code !== 0) {
      fail(
        2,
        `base-sync: --base '${baseOverride}' is not a valid branch name.`,
        "It must name a single branch, not a refspec ('git check-ref-format --branch' refused it).",
      );
    }
  }

  // Anchored to `DRIVE_PR_WORKTREE` when the driver set one: a pass's shell
  // cwd persists across tool calls, and a `cd` to the main checkout or
  // another worktree would otherwise make `--show-toplevel` resolve THAT
  // tree's root — silently measuring or merging against the wrong checkout
  // (docomply-review, a reference-implementation pull request), the same hazard `drive-status.ts`'s own
  // local-head read guards against. A round run by hand, with no driver and
  // no `DRIVE_PR_WORKTREE`, falls back to the ambient cwd exactly as before.
  const anchor = process.env.DRIVE_PR_WORKTREE;
  const rootRes = await git(["rev-parse", "--show-toplevel"], {
    stderr: "inherit",
    env: identityEnv,
    timeoutSec: gitTimeout,
    ...(anchor ? { cwd: anchor } : {}),
  });
  if (rootRes.code !== 0 || rootRes.stdout.trim() === "") {
    fail(1, "base-sync: not inside a git worktree");
  }
  const root = rootRes.stdout.trim();

  // An explicit positional PR does NOT quietly outrank the driver's own
  // notion of which PR this worktree is for — the same refusal
  // `guarded-push.ts` makes, and for the same reason: a mistargeted
  // `base-sync.ts 1234` under a drive for #999 would otherwise read #1234's
  // base/head branches and then merge into whatever HEAD actually is in this
  // worktree (#999's), reporting success against a PR it never touched.
  const target = process.env.DRIVE_PR_TARGET ?? "";
  if (target !== "" && pr !== "" && pr !== target) {
    fail(
      2,
      `base-sync: PR #${pr} was passed explicitly but the drive target is #${target}.`,
      "Refusing to guess which one you meant: merging the wrong PR's base",
      "into this worktree is not undoable by dropping a flag. Drop the",
      "argument, or unset DRIVE_PR_TARGET.",
    );
  }
  if (pr === "") pr = target;
  pr = await resolvePr(pr);
  if (pr === "") {
    fail(
      2,
      "base-sync: no PR number given and none could be resolved for this branch",
    );
  }

  // Base and head branch come from the PR, and it is the same one call that
  // answers liveness — so reading them costs no extra round-trip over the
  // liveness check this has to make anyway.
  const view = await ghCall([
    "pr",
    "view",
    pr,
    "--json",
    "state,baseRefName,headRefName,headRefOid",
  ]);
  if (view.code !== 0) fail(1, `base-sync: cannot read PR #${pr}`);
  let meta: {
    state?: string;
    baseRefName?: string;
    headRefName?: string;
    headRefOid?: string;
  };
  try {
    meta = JSON.parse(view.stdout) as typeof meta;
  } catch {
    fail(1, `base-sync: PR #${pr} returned unparseable JSON`);
  }
  // GitHub has no per-PR "base repository" field — a PR's base is, by
  // definition, whatever repository it was filed against, which is exactly
  // "the repository `gh` resolved this whole call to" (local git remotes,
  // `$GH_REPO`, `gh repo set-default`). `gh repo view` answers that same
  // resolution, the identical read `drive-status.ts` already makes for its
  // own copy of this check.
  const repoView = await cachedRepoView(["--json", "owner,name"]);
  let baseRepo = "";
  if (repoView.code === 0) {
    try {
      const repoMeta = JSON.parse(repoView.stdout) as {
        owner?: { login?: string };
        name?: string;
      };
      const repoOwner = repoMeta.owner?.login ?? "";
      const repoName = repoMeta.name ?? "";
      if (repoOwner !== "" && repoName !== "") {
        baseRepo = `${repoOwner}/${repoName}`;
      }
    } catch {
      // Left empty — the fail-closed check below refuses on it.
    }
  }
  // Liveness gates the MERGE, not the measurement. `--check` never merges,
  // commits or pushes — it does still run `git fetch` (see the usage comment
  // above), a read-refresh with no effect on the PR itself — and a report
  // that refuses on one of the states it exists to describe is a report a
  // caller has to special-case — the same reason `driftLine` degrades rather
  // than throws.
  if (!check && meta.state !== "OPEN") {
    fail(
      5,
      `base-sync: PR #${pr} is ${meta.state ?? "unreadable"}, not OPEN — refusing to merge its base into this branch`,
    );
  }
  const baseBranch =
    baseOverride !== "" ? baseOverride : (meta.baseRefName ?? "");
  const headRef = meta.headRefName ?? "";
  const headOid = meta.headRefOid ?? "";
  if (baseBranch === "" || headRef === "") {
    fail(
      1,
      `base-sync: PR #${pr} did not report both a base and a head branch`,
    );
  }

  // The checkout itself must be the PR's own head branch before this may
  // MEASURE or MERGE against it — the `DRIVE_PR_TARGET` check above only
  // catches a mistargeted *driver*; run by hand from an unrelated branch or a
  // detached checkout, nothing else stops this from reading whatever happens
  // to be checked out here and reporting the result — merged or measured —
  // against a PR it never touched. `--check` never merges or writes to the
  // tree, but it is NOT exempt: `probeBaseDrift()` below reads this same
  // checkout's `HEAD` regardless of mode, so a checkout that is not this PR's
  // own produces a `behind`/`prFiles`/`overlap` report that describes a
  // hybrid — this worktree's actual HEAD against the requested PR's base —
  // mislabeled with the requested PR's number (docomply-review +
  // chatgpt-codex-connector, a reference-implementation pull request). This is an unreadable-input refusal,
  // the same category as the unconcluded-git-op check below, not a verdict
  // about drift — so it applies whether or not `--check` was passed.
  const branchRes = await git(
    ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"],
    { stderr: "ignore", timeoutSec: gitTimeout, env: identityEnv },
  );
  if (branchRes.code !== 0) {
    fail(1, "base-sync: cannot read this worktree's current branch");
  }
  const branch = branchRes.stdout.trim();
  if (branch !== headRef) {
    fail(
      2,
      `base-sync: this worktree is on ${branch === "HEAD" ? "a detached HEAD" : `'${branch}'`}, not PR #${pr}'s head branch '${headRef}'.`,
      "Measuring or merging against the wrong checkout would report a result",
      "against a PR it never touched. Check out the PR's head branch first,",
      "or pass the PR that matches this checkout.",
    );
  }

  // A matching BRANCH NAME is not proof this checkout IS the PR: a fork PR
  // or an unrelated local branch can share a name, and a different HEAD
  // under that name is then read by `alreadyPushing()` as an unpushed local
  // commit, merging the PR's base into unrelated history — or, under
  // `--check`, measured as that PR's own drift
  // (docomply-review + chatgpt-codex-connector, a reference-implementation pull request). `--is-ancestor`
  // also accepts equality — a commit is its own ancestor — so this passes
  // both when local HEAD *is* the PR's head and when it carries genuine
  // local commits on top of it, and refuses whenever the relationship
  // cannot be established (a diverged branch, or an object this worktree
  // never fetched at all — the fork/unrelated-branch case).
  //
  // Required unconditionally, `--force` and `--check` included: in normal
  // mode an empty `headOid` is later caught by `alreadyPushing()`, but
  // `--force` skips that call entirely, so a `headOid`-less path here would
  // let an incomplete `gh pr view` response plus a same-named unrelated local
  // branch merge the PR's base into unrelated history under `--force`
  // (docomply-review, a reference-implementation pull request).
  if (headOid === "") {
    fail(
      1,
      `base-sync: PR #${pr} did not report a head commit (headRefOid) to verify this checkout against.`,
      "A matching branch name is not proof this checkout IS that PR — refusing to measure",
      "or merge without a head commit to check ancestry against, even under --force.",
    );
  }
  const ancestorRes = await git(
    ["-C", root, "merge-base", "--is-ancestor", headOid, "HEAD"],
    { stderr: "ignore", timeoutSec: gitTimeout, env: identityEnv },
  );
  if (ancestorRes.code !== 0) {
    fail(
      2,
      `base-sync: PR #${pr}'s reported head commit ${headOid.slice(0, 12)} is not this worktree's HEAD or an ancestor of it.`,
      "A branch named the same as the PR's head branch is not proof this checkout IS that",
      "PR — a fork PR or an unrelated local branch can share a name. Check out the PR's",
      "actual head commit first, or pass the PR that matches this checkout.",
    );
  }

  // FIRST, before the fetch and before any measurement: an unconcluded git
  // operation makes every diff below compare against a working tree that still
  // holds the whole incoming operation (the failure AGENTS.md
  // § Change-Proportional Validation checks the same markers for), and
  // starting a merge on top of one is strictly worse than refusing.
  const marker = await unconcludedGitOpMarker(gitTimeout, {
    cwd: root,
    env: identityEnv,
  });
  if (!marker.ok) {
    fail(3, "base-sync: cannot read this worktree's git state — refusing");
  }
  if (marker.marker !== null) {
    fail(
      3,
      `base-sync: an unconcluded git operation (${marker.marker}) is already open in this worktree.`,
      "Conclude or abort it first: git merge --abort / git cherry-pick --abort / git revert --abort / git rebase --abort",
    );
  }

  // `probeBaseDrift` below fetches the base branch unconditionally through
  // `origin` — correct only when `origin` IS the PR's own repository. Verify
  // that BEFORE the fetch: a fork PR driven from a clone of the fork, or a
  // `gh`/git disagreement (`$GH_REPO`, `gh repo set-default`), would
  // otherwise measure — and potentially merge — drift from a same-named
  // branch in the wrong repository's history, silently
  // (chatgpt-codex-connector, a reference-implementation pull request).
  if (baseRepo === "") {
    fail(
      1,
      "base-sync: could not resolve this repository via `gh repo view` — refusing to fetch the base branch from an unverified 'origin'.",
    );
  }
  const originCheck = await verifyOriginIsPrRepo(
    git,
    root,
    baseRepo,
    identityEnv,
  );
  if (!originCheck.ok) {
    fail(1, `base-sync: ${originCheck.why}`);
  }

  const probe = await probeBaseDrift(
    git,
    root,
    baseBranch,
    fetchSec.seconds,
    identityEnv,
  );
  if (!probe.ok) fail(1, `base-sync: ${probe.why}`);
  const drift = probe.drift;
  const verdict = driftVerdict(drift);

  const emit = (report: Report): void => {
    if (json) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      const line = driftLine(drift);
      if (line !== null) process.stdout.write(`${line}\n`);
      process.stdout.write(`base-sync: ${report.action} (${report.reason})\n`);
    }
  };

  const base: Report = {
    pr: Number.parseInt(pr, 10),
    action: "none",
    reason: "in-sync",
    drift,
    mergeCommit: null,
  };

  // A mutating merge may not proceed off a measurement the fetch never
  // confirmed: `probeBaseDrift` deliberately degrades to a MARKED
  // measurement on a failed fetch rather than failing outright (so `--check`
  // can still report it), but a stale `origin/<base>` can both overlap and
  // miss a real, currently-unmergeable divergence — merging it would report
  // `action: "merged"` while the actual base remains ahead, and can spend a
  // reviewer cycle without achieving the synchronization this exists to
  // provide (docomply-review + chatgpt-codex-connector, a reference-implementation pull request). `--force`
  // drops the overlap and already-pushing preconditions, never this one —
  // same rule as never dropping precondition 1. `resolveReadReason` checks
  // this ahead of every verdict branch, `--check` aside, so a stale fetch
  // never gets reported as a confirmed `in-sync`/`no-overlap` verdict.
  const readReason = resolveReadReason(check, verdict, drift.fetched, force);
  if (readReason !== null) {
    emit({ ...base, reason: readReason });
    return 0;
  }
  if (!force) {
    const pushing = await alreadyPushing(git, root, headOid, identityEnv);
    if (!pushing.ok) {
      fail(
        1,
        `base-sync: cannot tell whether this round is already pushing — ${pushing.why}.`,
        "Refusing to merge on an unverifiable precondition rather than guessing either way;",
        "re-run once the underlying read succeeds.",
      );
    }
    if (!pushing.pushing) {
      emit({ ...base, reason: "nothing-to-piggyback" });
      return 0;
    }
  }

  // From here on this function MUTATES the working tree (`git merge`), so it
  // takes the same tree-lease fence `guarded-push.ts` takes before its own
  // mutation: another live session in this tree could otherwise
  // change the checkout — dirty it, move HEAD, start its own merge — in the
  // gap between the checks above and `git merge` below, and this script
  // would merge into, or "restore", the wrong concurrent state
  // (docomply-review, a reference-implementation pull request). `null` only when no repository is in play
  // at all (`resolveFenceContext`'s own no-op case); `--check` never reaches
  // this point (`readReason` above already returned), so there is no
  // separate check-mode skip to write.
  const fenceCtx = await resolveFenceContext("base-sync.ts");
  const treeLock =
    fenceCtx === null
      ? null
      : await assertTreeMutationAllowed(fenceCtx, pr, "base-sync.ts");
  try {
    // Liveness and checkout identity were both read well before this point —
    // liveness up front, identity before the fetch — and the fetch plus the
    // tree-lock wait just above (documented as potentially five minutes) can
    // leave a real gap behind them. Re-verify both immediately before the one
    // irreversible act below rather than trusting reads that are now stale;
    // see `verifyStillCurrent`'s own doc comment for why (docomply-review,
    // a reference-implementation pull request).
    const stillCurrent = await verifyStillCurrent(
      (args, opts) =>
        git(args, {
          stderr: "ignore",
          timeoutSec: gitTimeout,
          env: identityEnv,
          ...opts,
        }),
      ghCall,
      root,
      pr,
      headRef,
      headOid,
      identityEnv,
    );
    if (!stillCurrent.ok) {
      fail(stillCurrent.code, `base-sync: ${stillCurrent.why}`);
    }

    // `alreadyPushing` (and `--force`, which skips it) both treat an
    // UNCOMMITTED change in the worktree as license to merge — but starting
    // `git merge --no-ff` over a dirty tree is unsafe: a staged change that
    // does not conflict with the incoming diff can be silently folded into the
    // merge commit instead of staying this round's own change, and — if the
    // merge DOES conflict — `git merge --abort` is not guaranteed to
    // reconstruct pre-existing uncommitted state losslessly. Only a clean tree
    // lets this function's "the worktree was restored" claim below be
    // something it verified rather than assumed. A committed local HEAD still
    // satisfies the piggyback predicate; this is the same refusal SKILL.md § 5's
    // exit-3 row already documents ("local changes stood in the merge's way")
    // — enforced up front here rather than left to however `git merge` itself
    // happens to react to the particular files involved. The recovery is to
    // validate this round's own diff and commit it BEFORE re-running this
    // script, never to commit merely to unblock the merge without having
    // validated first (docomply-review + chatgpt-codex-connector, a reference-implementation pull request).
    // `--untracked-files=normal`/`--ignore-submodules=none` for the same reason
    // `alreadyPushing` above carries them: a plain `--porcelain` can read an
    // untracked file or ignored submodule change as a clean tree depending on
    // repo/user config, letting a merge start over state that is not actually
    // clean (chatgpt-codex-connector, a reference-implementation pull request).
    const dirty = await git(
      [
        "-C",
        root,
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--ignore-submodules=none",
      ],
      {
        timeoutSec: gitTimeout,
        env: identityEnv,
      },
    );
    if (dirty.code !== 0) {
      fail(
        1,
        "base-sync: cannot read this worktree's status before merging — refusing",
      );
    }
    if (dirty.stdout.trim() !== "") {
      fail(
        3,
        `base-sync: refusing to merge ${drift.baseRef} into a dirty worktree.`,
        "Validate this round's own diff and commit it, then re-run. Nothing was",
        "merged. Never commit merely to unblock this merge without validating first",
        "(the dirty tree IS this round's complete change — validate it as one).",
      );
    }

    // Snapshotted so a failed merge's claim that the worktree was restored is
    // something this function VERIFIES against, not something it infers from
    // the absence of a MERGE_HEAD marker alone. That marker is cleared the
    // instant a merge commit lands, so a `post-merge` hook that hangs or fails
    // afterward — e.g. until GIT_CALL_TIMEOUT — makes `git merge` exit nonzero
    // with HEAD already mutated and no marker left to notice it by
    // (chatgpt-codex-connector, a reference-implementation pull request).
    const preMergeHeadRes = await git(["-C", root, "rev-parse", "HEAD"], {
      stderr: "ignore",
      timeoutSec: gitTimeout,
      env: identityEnv,
    });
    if (preMergeHeadRes.code !== 0 || preMergeHeadRes.stdout.trim() === "") {
      fail(
        1,
        "base-sync: cannot read this worktree's HEAD before merging — refusing",
      );
    }
    const preMergeHead = preMergeHeadRes.stdout.trim();

    const merge = await git(
      [
        "-C",
        root,
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `chore(drive-pr): merge ${drift.baseRef} into ${headRef}`,
        drift.baseRef,
      ],
      { stderr: "inherit", timeoutSec: gitTimeout, env: identityEnv },
    );

    if (merge.code !== 0) {
      // Several different failures share this exit status, and neither the
      // marker's presence nor its absence alone proves what happened to HEAD:
      // git can refuse a merge it never started (no MERGE_HEAD, nothing to
      // abort), leave MERGE_HEAD behind when the merge started and hit a real
      // conflict, or — the case above — clear MERGE_HEAD on landing a commit
      // and then fail from a hook that runs after. Restoration is judged
      // against the HEAD snapshot taken before the attempt, never against the
      // marker alone.
      const after = await unconcludedGitOpMarker(gitTimeout, {
        cwd: root,
        env: identityEnv,
      });
      if (!after.ok) {
        fail(
          3,
          "base-sync: the merge failed AND this worktree's git state is now unreadable.",
          "Inspect it by hand before running anything else: git status && git merge --abort",
        );
      }

      // `MERGE_HEAD` being present does not by itself mean git left an
      // unmerged file behind: `githooks(5)`'s `pre-merge-commit` runs after git
      // has already resolved the merge into the index and working tree, and a
      // nonzero exit from it blocks the commit while leaving that same marker
      // — indistinguishable from a real conflict by marker alone. Read the
      // index for actual unmerged (stage 1/2/3) paths while it still reflects
      // the failed attempt, before the abort below discards it
      // (chatgpt-codex-connector, a reference-implementation pull request).
      let hadUnmergedPaths = true;
      if (after.marker !== null) {
        const unmerged = await git(
          ["-C", root, "diff", "--name-only", "--diff-filter=U"],
          { stderr: "ignore", timeoutSec: gitTimeout, env: identityEnv },
        );
        hadUnmergedPaths = unmerged.code !== 0 || unmerged.stdout.trim() !== "";

        const abort = await git(["-C", root, "merge", "--abort"], {
          stderr: "inherit",
          timeoutSec: gitTimeout,
          env: identityEnv,
        });
        if (abort.code !== 0) {
          fail(
            3,
            `base-sync: ${drift.baseRef} conflicts with this branch, and 'git merge --abort' itself failed.`,
            "Resolve or abort it by hand before anything else runs here: git status && git merge --abort",
          );
        }
      }

      // Verify HEAD is genuinely back where it started — first by reading it,
      // then, if that read disagrees, by forcing it back — rather than trusting
      // an abort (or a merge that never started) to have already left it there.
      // `HEAD` and the marker alone prove the git METADATA is restored; they
      // say nothing about the worktree itself, which is why the final check is
      // `worktreeClean` rather than returning as soon as `HEAD` matches
      // (docomply-review, a reference-implementation pull request).
      const atPreMergeHead = async (): Promise<boolean> => {
        const marker = await unconcludedGitOpMarker(gitTimeout, {
          cwd: root,
          env: identityEnv,
        });
        if (!marker.ok || marker.marker !== null) return false;
        const head = await git(["-C", root, "rev-parse", "HEAD"], {
          stderr: "ignore",
          timeoutSec: gitTimeout,
          env: identityEnv,
        });
        if (head.code !== 0 || head.stdout.trim() !== preMergeHead)
          return false;
        return worktreeClean(git, root, identityEnv);
      };

      let restored = await atPreMergeHead();
      if (!restored) {
        await git(["-C", root, "reset", "--hard", preMergeHead], {
          stderr: "inherit",
          timeoutSec: gitTimeout,
          env: identityEnv,
        });
        restored = await atPreMergeHead();
      }
      if (!restored) {
        fail(
          3,
          `base-sync: ${drift.baseRef} could not be merged, and this worktree could not be verified back at its pre-merge HEAD (${preMergeHead.slice(0, 12)}).`,
          "It may still be mid-operation or sitting on a stray commit. Inspect and fix by hand:",
          "  git status && git log --oneline -3",
        );
      }

      if (after.marker === null) {
        fail(
          3,
          `base-sync: git did not complete the merge of ${drift.baseRef} (no conflict was left mid-operation).`,
          "The worktree has been verified back at its pre-merge HEAD. Nothing was merged.",
        );
      }
      if (!hadUnmergedPaths) {
        fail(
          3,
          `base-sync: ${drift.baseRef} merged cleanly into this branch, but the merge commit was never created.`,
          "No file was left unmerged, so this is not a content conflict — a git hook",
          "(pre-merge-commit, most plausibly) most likely rejected it; check its output above.",
          "The worktree was restored — nothing is half-merged. Fix or bypass the hook, then re-run.",
        );
      }
      // `--force` proceeds on a `no-overlap` verdict too (it drops that
      // precondition, never the fetch-freshness one), where `overlapCount` is
      // genuinely 0 — yet the merge above still failed, so a conflict exists
      // outside the measured file-level overlap (content conflicts, directory
      // renames). Reporting "conflicts ... over 0 shared file(s)" would
      // contradict itself for the operator who has to act on it
      // (coderabbitai, PR #4279).
      fail(
        9,
        drift.overlapCount > 0
          ? `base-sync: ${drift.baseRef} conflicts with this branch over ${drift.overlapCount} shared file(s).`
          : `base-sync: ${drift.baseRef} conflicts with this branch (no file-level overlap was measured).`,
        "The worktree was restored — nothing is half-merged. Resolve it deliberately:",
        `  git merge ${drift.baseRef}   # then the resolving-merge-conflicts skill`,
        "Then run this round's validation plan (SKILL.md § 5) and push.",
      );
    }

    const headSha = await git(["-C", root, "rev-parse", "HEAD"], {
      stderr: "ignore",
      timeoutSec: gitTimeout,
      env: identityEnv,
    });
    emit({
      ...base,
      action: "merged",
      reason: "merged",
      mergeCommit: headSha.code === 0 ? headSha.stdout.trim() : null,
    });
    return 0;
  } finally {
    if (treeLock !== null) {
      treeLock.release();
      treeLock.dispose();
    }
  }
}

// Guarded the same way reap-state.ts / defect-escape.ts / summary-findings.ts
// / round-plan.ts guard their own entry: this module's side effect is real
// git/gh I/O and a process exit code, and unconditionally running `main()` at
// import time would fire that against the IMPORTING process's own argv —
// exactly what base-sync.test.ts now does to reach `alreadyPushing` directly.
// `existsSync` + `realpathSync` (not the bare `resolve(argv[1]) ===
// fileURLToPath(...)` defect-escape.ts, summary-findings.ts and
// round-plan.ts still use) because a symlinked invocation path leaves
// `process.argv[1]` unresolved under Node while `fileURLToPath(import.meta.url)`
// is already canonical — reap-state.ts's own comment has the measurement
// (chatgpt-codex-connector / coderabbitai, PR #4197 rounds 17-18).
let isEntryPoint = false;
if (process.argv[1] !== undefined) {
  try {
    isEntryPoint =
      existsSync(process.argv[1]) &&
      realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    // Unresolvable argv[1] — fail closed, same as the ENOENT case above.
  }
}
if (isEntryPoint) {
  runMain("base-sync.ts", main);
}

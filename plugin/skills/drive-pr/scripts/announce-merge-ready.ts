#!/usr/bin/env bun
/**
 * Say, on the PR itself, that the drive is finished and the branch looks safe
 * to merge FROM THE DRIVER'S PERSPECTIVE — which is a narrower claim than
 * "merge this", and is worded that way deliberately. Marking a PR ready and
 * merging it both stay human steps.
 *
 * It refuses to post on anything short of verified convergence:
 * `drive-status.ts` must report CONVERGED (posting reviewer completed on this
 * exact head, its recorded reviewed-SHA equal to that head, zero unresolved
 * threads, zero unaddressed summary findings) AND its non-reviewer CI verdict
 * must be exactly `green` AND this worktree must be clean. That verdict
 * accepts a completed `neutral` or `skipped` check run as not-failing, so the
 * posted wording says that rather than claiming every check passed; the
 * clean-tree gate exists because the other two are claims about the remote
 * and cannot see an edit no round shipped. An announcement is the one
 * artefact a human is most likely to act on without re-deriving it, so it is
 * gated harder than the loop's own exit, and worded no stronger than the
 * evidence behind it.
 *
 * Usage:
 *   announce-merge-ready.ts [PR] [--dry-run] [< follow-ups.md]
 *
 * Optional stdin is a follow-ups list (deferred issue links, wont-fix items
 * worth a human glance). When stdin is empty the section is OMITTED ENTIRELY
 * — no "Follow-ups: none" boilerplate. A standing empty section trains
 * readers to skip the block, which is exactly where the non-empty case needs
 * their eyes.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { announcedIds, announcements, OPENER } from "./lib/announce.ts";
import { parsePrSnapshot } from "./lib/ci-hold.ts";
import { fail, isDigits, readStdinAll, runMain, short } from "./lib/cli.ts";
import {
  ciHoldTimeoutSeconds,
  ghCall,
  git,
  gitCallTimeoutSeconds,
  readTimeoutEnv,
  resolvePr,
  run,
  tsArgv,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import { TRUSTED_ASSOCIATIONS } from "./summary-findings.ts";

const here = dirname(fileURLToPath(import.meta.url));
const driveStatus = join(here, "drive-status.ts");
const driveState = join(here, "drive-state.ts");
const ciHold = join(here, "ci-hold.ts");

interface Liveness {
  state: "OPEN" | "CLOSED" | "MERGED";
  head: string;
  ciHeld: boolean;
}

/** `state` + `head` for the PR, right now. `null` when unreadable. */
async function readLiveness(pr: string): Promise<Liveness | null> {
  const r = await ghCall(
    ["pr", "view", pr, "--json", "state,headRefOid,labels"],
    {
      stderr: "ignore",
    },
  );
  if (r.code !== 0) return null;
  try {
    const parsed = parsePrSnapshot(JSON.parse(r.stdout) as unknown);
    if (parsed === null) return null;
    return {
      state: parsed.state,
      head: parsed.head,
      ciHeld: parsed.held,
    };
  } catch {
    return null;
  }
}

/**
 * Is the worktree clean, right now? Called at the up-front pass and again at
 * the last possible point before every success path this script can take —
 * never trusted from an earlier call, since real work (a comment sweep, a
 * liveness re-read, an API round-trip) sits between each of those points and
 * an edit can land in that window. `0` means confirmed clean; `1` means dirty
 * or unreadable, with the reason already on stderr — the caller returns it
 * verbatim.
 */
async function checkWorktreeClean(reviewedHead: string): Promise<number> {
  // Every check below answers "is the tree clean", never "is this the commit
  // that was reviewed" — and those are different questions. If another
  // process (a concurrent pane, a stray `git commit`) commits a new local
  // change while this script is mid-run — there are several API round-trips
  // between calls, and `drive.ts` similarly runs its handoff helper first —
  // `git status` reads EMPTY (nothing uncommitted) and no unconcluded-op
  // marker is present, so every check below would pass over local HEAD
  // having silently moved from the reviewed commit to an unreviewed one that
  // was never pushed (chatgpt-codex-connector, a reference-implementation pull request review round 4).
  // Checked first, since a HEAD mismatch makes every check below beside the
  // point regardless of what they would have found.
  const headTimeoutSec = gitCallTimeoutSeconds();
  const localHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (localHeadRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  const localHead = localHeadRes.stdout.trim();
  if (localHead !== reviewedHead) {
    console.error(
      `announce-merge-ready: local HEAD is ${localHead}, but the reviewed head is`,
    );
    console.error(
      `${reviewedHead} — a commit landed here that was never pushed or reviewed.`,
    );
    console.error(
      "Refusing to announce. Push it, or reset to the reviewed head, then re-run.",
    );
    return 1;
  }

  // A `git status --porcelain` predicate — however hardened — answers "is
  // anything uncommitted", not "is a git operation still open": resolving a
  // conflict back to a tree that matches what was already committed leaves
  // `MERGE_HEAD` behind while porcelain status reports empty
  // (chatgpt-codex-connector, a reference-implementation pull request review round 3). Checked next, before
  // the status call below, because a marker present makes the status answer
  // beside the point either way.
  const opTimeoutSec = gitCallTimeoutSeconds();
  const op = await unconcludedGitOpMarker(opTimeoutSec);
  if (!op.ok) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  if (op.marker !== null) {
    console.error(
      `announce-merge-ready: an unconcluded git operation is present (${op.marker}) —`,
    );
    console.error(
      "refusing to announce. Resolve or abort it (git merge/cherry-pick/revert --abort),",
    );
    console.error("then re-run.");
    return 1;
  }

  // `--untracked-files=normal` is explicit, not decorative: `--porcelain`
  // alone inherits `status.showUntrackedFiles` from repo or user config, and
  // `=no` there makes a plain `git status --porcelain` report an untracked
  // scratch file as a clean tree — silently certifying a leftover as shipped
  // (chatgpt-codex-connector, a reference-implementation pull request review round 2). An explicit mode
  // overrides whatever the config says, the same way `--porcelain`'s own
  // stable machine format is chosen over the human one regardless of
  // `status.short`. `--ignore-submodules=none` closes the same class of
  // bypass one level down: `submodule.<name>.ignore`/`.gitmodules` can set
  // `ignore = all` on a tracked submodule, which makes a plain `git status`
  // hide modifications inside it regardless of the untracked-files mode
  // (docomply-review, a reference-implementation pull request review round 3).
  const dirtyRes = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    {
      stderr: "ignore",
      timeoutSec: gitCallTimeoutSeconds(),
    },
  );
  if (dirtyRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  if (dirtyRes.stdout !== "") {
    console.error(
      "announce-merge-ready: review converged, but this worktree still has uncommitted state:",
    );
    process.stderr.write(dirtyRes.stdout);
    console.error(
      "These edits shipped in no round — commit or discard them, then re-run.",
    );
    return 1;
  }

  // Re-read local HEAD once more, immediately before reporting clean. The
  // check at the top of this function narrows the window a commit can land
  // in undetected; it cannot close it, because the operation-marker and
  // status probes above are themselves further elapsed time after that read
  // — a commit landing in that gap leaves `git status` reporting a clean H2
  // while this function was about to vouch for reviewed H1
  // (chatgpt-codex-connector, a reference-implementation pull request review round 5). This is the same
  // "narrows, does not close, so re-check at the latest possible point"
  // treatment `retractStale`'s own comment describes for the analogous PR
  // head race — applied here to the LOCAL head instead.
  const finalHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (finalHeadRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  const finalHead = finalHeadRes.stdout.trim();
  if (finalHead !== reviewedHead) {
    console.error(
      `announce-merge-ready: local HEAD is ${finalHead}, but the reviewed head is`,
    );
    console.error(
      `${reviewedHead} — a commit landed here during this check that was never pushed`,
    );
    console.error(
      "or reviewed. Refusing to announce. Push it, or reset to the reviewed head,",
    );
    console.error("then re-run.");
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  let pr = "";
  let dryRun = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--")) fail(2, `unknown flag: ${a}`);
    else pr = a;
  }
  pr = await resolvePr(pr);
  if (!isDigits(pr)) {
    fail(2, "announce-merge-ready: could not resolve a PR number");
  }

  // Read stdin BEFORE the status call: a terminal with no redirect would
  // otherwise block here after the network round-trip, looking like a hung
  // API call.
  let followups = "";
  if (!process.stdin.isTTY) {
    followups = await readStdinAll();
  }

  // The helper deadline bounds the sibling-script spawns below the same way
  // GH_CALL_TIMEOUT bounds direct `gh` calls — mode 13 in
  // references/terminal-states.md — validated with the same refusal semantics
  // drive-status.ts and resolve-held-thread.ts apply, since an unvalidated `0`
  // would run them unbounded, the exact hang the deadline exists to prevent.
  const helperRead = readTimeoutEnv("DRIVE_PR_HELPER_TIMEOUT", 120);
  if (!helperRead.ok) {
    fail(
      2,
      `announce-merge-ready: $DRIVE_PR_HELPER_TIMEOUT must be a positive whole number of seconds (got '${helperRead.raw}').`,
    );
  }
  const helperTimeoutSec = helperRead.seconds;

  // ── Reconciliation runs BEFORE the convergence and CI gates ───────────────
  // Those gates decide whether THIS run may announce. A stale "Safe to merge"
  // left by an interrupted earlier run is wrong regardless, and gating its
  // cleanup behind them left it standing for the whole of the next head's
  // review — every invocation during that window exited at `not CONVERGED` or
  // `CI is pending` before reaching the retraction. That is precisely the
  // window in which a human is most likely to read the comment and act on it.

  // Withdraw any announcement standing for a head that is no longer the PR's.
  //
  // Staleness is judged against a FRESHLY READ live head, never against the
  // status report's head. That head is what drive-status.ts reports when this
  // run starts, and deleting by it is destructive in exactly the case that
  // matters: if the PR advanced H1→H2 in the meantime and another driver
  // validly announced H2, an H1 invocation would classify that correct,
  // current announcement as stale and delete it — only discovering H2 later,
  // at the pre-POST check, having already destroyed the artefact. A cleanup
  // that can delete the right answer is worse than the residue it collects.
  //
  // Anything that leaves the live head unknown means retracting NOTHING.
  // Cleanup has no deadline; deleting on a guess does not get a second
  // chance.
  //
  // Best effort in the other direction too: a failed DELETE is reported,
  // never fatal, because this is a PREVIOUS run's residue and refusing to
  // proceed over it would let one un-deletable comment block every future
  // announcement on the PR. The announcement this run is about to make is
  // gated by its own checks.
  async function retractStale(liveHead: string): Promise<void> {
    if (liveHead === "") return;
    const all = await announcements(pr, TRUSTED_ASSOCIATIONS);
    if (all === null) return;
    for (const { id, head: sha } of all) {
      if (sha === liveHead) continue;
      // "Not the head I read" is NOT the same as "stale", and treating it as
      // such is what makes this cleanup dangerous. The live head was read
      // before this loop and nothing can read it atomically with the DELETE,
      // so if the PR advances H1→H2 in between and another driver announces
      // H2, an H1 process sees an unfamiliar head and deletes the CORRECT
      // artefact. Narrowing that window does not close it, and no ordering of
      // two API calls will.
      //
      // So the test is not "is this the head I read" but "has the PR
      // demonstrably moved PAST this commit" — is it a STRICT ANCESTOR of the
      // head. An announcement for a descendant (H2 while we believe H1) is
      // not an ancestor, so it is never deleted no matter how the
      // interleaving falls; the destructive direction is closed by the
      // predicate rather than by timing. An unresolvable object — shallow
      // clone, never fetched, or simply not ours — is not evidence of
      // anything, so it is left alone too. Cleanup has no deadline; deleting
      // on a guess does not get a second chance.
      const ancestor = await git(
        ["merge-base", "--is-ancestor", sha, liveHead],
        {
          stderr: "ignore",
        },
      );
      if (ancestor.code !== 0) {
        console.error(
          `announce-merge-ready: leaving comment ${id} alone — ${sha} is not an ancestor`,
        );
        console.error(
          `of the live head ${liveHead}, so it is not residue this run may clear.`,
        );
        continue;
      }
      console.error(
        `announce-merge-ready: retracting a stale announcement (comment ${id}) that still`,
      );
      console.error(
        `vouches for ${sha}, which PR #${pr} has moved past (now ${liveHead}).`,
      );
      const del = await ghCall(
        ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`],
        { stdout: "ignore", stderr: "ignore" },
      );
      if (del.code !== 0) {
        console.error(
          `announce-merge-ready: could NOT delete comment ${id} — remove it by hand.`,
        );
      }
    }
  }

  // Liveness FIRST, before anything that can exit claiming success.
  //
  // The "already announced, nothing to do" path below is an exit-0 success,
  // and it used to be reachable without any fresh liveness check at all: the
  // sweep that feeds it was taken against the status report's head — what
  // drive-status.ts reported when this run started — so on a PR that had
  // since advanced H1→H2 it found the H1 announcement and reported the job
  // done, with no announcement existing for H2 and nothing saying so.
  // Ordering the checks so the cheap sweep came first made the guard
  // skippable by the very case it exists for.
  //
  // It is also what makes swallowing a `retractStale` failure sound rather
  // than convenient: cleanup is best-effort, and if it fails the early return
  // below is still standing on a liveness check taken in THIS run, not on the
  // absence of one. Without this block, an unreadable liveness read or a
  // failed DELETE inside the cleanup would hand the early return an H1 answer
  // and no guard at all.
  const live = await readLiveness(pr);
  if (live === null) {
    fail(
      1,
      `announce-merge-ready: cannot read PR #${pr}'s state and head — refusing to`,
      "announce, or to report an existing announcement, on an unknown state.",
    );
  }
  if (live.state !== "OPEN") {
    fail(
      5,
      `announce-merge-ready: PR #${pr} is ${live.state} — refusing to announce.`,
      "Merging is the decision this comment exists to inform, and it has been taken.",
    );
  }
  // Clear residue from earlier runs, judged against the head just confirmed
  // live. Skipped entirely under --dry-run: a DELETE is a real mutation and
  // the flag promises none — printing what WOULD be announced must not
  // quietly retract anything on the way.
  if (!dryRun) {
    await retractStale(live.head);
  }
  if (live.ciHeld) {
    // A same-head announcement is stale too: adding ci:hold deliberately
    // makes the head non-green until the final unlabel-triggered CI run. The
    // ordinary stale-head cleanup above cannot remove it because its marker
    // still names the live head, so retract it explicitly before refusing.
    if (!dryRun) {
      const standing = await announcements(pr, TRUSTED_ASSOCIATIONS);
      if (standing === null) {
        fail(
          1,
          `announce-merge-ready: cannot read PR #${pr}'s comments while ci:hold is present — remove any standing merge-ready announcement by hand.`,
        );
      }
      for (const id of announcedIds(standing, live.head)) {
        const del = await ghCall(
          ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`],
          { stdout: "ignore", stderr: "inherit" },
        );
        if (del.code !== 0) {
          fail(
            del.code,
            `announce-merge-ready: could not withdraw held-head announcement ${id} — remove it by hand.`,
          );
        }
      }
    }
  }

  // Bounded, unlike drive.ts's own status spawn: that one forwards `--timeout`
  // and is SUPPOSED to poll for as long as the driver asked. This one passes
  // `--once`, so a single evaluation is the whole contract and an invocation
  // outliving the helper deadline is a stall rather than a long wait. Left
  // unbounded it parks the one script whose job is to post a comment a human
  // acts on without re-deriving it.
  const statusRes = await run(
    tsArgv(driveStatus, [pr, "--json", "--once", "--no-count"]),
    { timeoutSec: helperTimeoutSec, stderr: "ignore" },
  );
  const code = statusRes.code;
  let status: Record<string, unknown> = {};
  const statusText = statusRes.stdout.trim();
  if (statusText === "") {
    fail(
      1,
      `announce-merge-ready: could not read drive status for #${pr} — not announcing`,
    );
  }
  try {
    status = JSON.parse(statusText) as Record<string, unknown>;
  } catch {
    fail(
      1,
      `announce-merge-ready: could not read drive status for #${pr} — not announcing`,
    );
  }

  const state = String(status.state ?? "");
  if (code !== 3 || state !== "CONVERGED") {
    console.error(
      `announce-merge-ready: #${pr} is ${state}, not CONVERGED — refusing to announce`,
    );
    console.error(String(status.reason ?? ""));
    // PR_NOT_OPEN is PRESERVED rather than flattened. The PR can be OPEN for
    // the up-front liveness read and merge before this status call, and `5`
    // is the one terminal answer a caller must not confuse with a broken
    // attempt: `1` says "this did not work, look at it", `5` says "stop, the
    // decision is taken". Every other read point in this script already
    // answers that condition with 5; a status call that discovered it first
    // must not be the exception.
    return code === 5 ? 5 : 1;
  }

  const convergedHead = String(
    (status.head as Record<string, unknown>)?.api ?? "",
  );
  if (convergedHead === "" || convergedHead !== live.head) {
    fail(
      4,
      `announce-merge-ready: converged status names ${convergedHead || "<unreadable>"}, but the live PR head is ${live.head}.`,
    );
  }
  if (live.ciHeld) {
    fail(
      4,
      "announce-merge-ready: review converged, but 'ci:hold' is still present. The drive must release its owned transition and establish full CI before this read-only announcer can proceed.",
    );
  }

  const ci = String(status.ci ?? "");
  if (ci !== "green") {
    fail(
      1,
      `announce-merge-ready: review converged but CI is '${ci}' — refusing to announce`,
    );
  }

  // Extracted here — as soon as `status` is parsed — rather than after the
  // up-front clean check below, so that check can compare local HEAD against
  // it too (round 4). Pure extraction from data already in hand; no new I/O.
  const head = convergedHead;
  const reviewer = String(
    (status.reviewer as Record<string, unknown>)?.app ?? "",
  );
  const source = String(
    (status.reviewer as Record<string, unknown>)?.reviewedShaSource ?? "",
  );

  // A green aggregate can still be the skipped-success residue from a held
  // synchronize run. Require both the global pointer written only by
  // set-verified and ci-hold's transition/freshness proof for this exact head.
  const verified = await run(tsArgv(driveState, ["verified", pr]), {
    stderr: "ignore",
    timeoutSec: helperTimeoutSec,
  });
  if (verified.code !== 0 || verified.stdout.trim() !== head) {
    fail(
      1,
      `announce-merge-ready: ${head} is not the globally green-verified SHA (recorded: ${verified.code === 0 ? verified.stdout.trim() || "<none>" : `<unreadable, exit ${verified.code}>`}) — refusing to announce`,
    );
  }
  async function finalCiProof(): Promise<number> {
    // `--require-success`: this is the ONLY re-confirmation this script
    // performs at each of its several `confirmFinalCi()` call sites — unlike
    // `drive.ts`, which re-derives green/red independently from
    // `drive-status.ts` after every `final-ready` call. Without it, a
    // required check rerun and failed after the single aggregate-status
    // snapshot taken at the top of this script (`ci !== 'green'`, above)
    // stays invisible for the rest of the run (chatgpt-codex-connector,
    // a reference-implementation pull request) — see `finalReady`'s own doc comment in ci-hold.ts for why
    // this is opt-in rather than the default for every caller.
    const result = await run(
      tsArgv(ciHold, [
        "final-ready",
        pr,
        "--expect-head",
        head,
        "--require-success",
      ]),
      { stderr: "inherit", timeoutSec: ciHoldTimeoutSeconds() },
    );
    return result.code;
  }
  const finalCi = await finalCiProof();
  if (finalCi !== 0) {
    if (!dryRun && finalCi === 4) {
      const standing = await announcements(pr, TRUSTED_ASSOCIATIONS);
      if (standing === null) {
        fail(
          1,
          `announce-merge-ready: final CI proof is stale and same-head announcements could not be enumerated; inspect PR #${pr} manually.`,
        );
      }
      for (const id of announcedIds(standing, head)) {
        const del = await ghCall(
          ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`],
          { stdout: "ignore", stderr: "inherit" },
        );
        if (del.code !== 0) {
          fail(
            1,
            `announce-merge-ready: final CI proof is stale, but comment ${id} could not be withdrawn; remove it manually.`,
          );
        }
      }
    }
    fail(
      finalCi === 5 ? 5 : finalCi === 4 ? 4 : 1,
      `announce-merge-ready: final CI/ci:hold evidence is stale or unreadable (exit ${finalCi})`,
    );
  }

  // The worktree must be clean too. CONVERGED and the CI verdict are claims
  // about the remote; neither sees an edit no round shipped (a scratch probe,
  // a regenerated artefact, a fix from a round that ended another way). This
  // comment is the artefact a human merges on without re-deriving it, and a
  // merge is exactly when an unshipped local edit dies silently — so the
  // announcement is gated on the same clean-tree check the per-thread
  // resolvers already enforce, and an unreadable tree refuses the same way.
  //
  // This is the CHEAP, up-front pass — a fail-fast before the comment sweep,
  // the liveness re-reads and the body construction that follow it, all of
  // which take real time and API calls. It is not the only check: this
  // script has two more places it can report success (the idempotent
  // "already announced" return and the POST itself), and everything between
  // here and each of them is a window in which the tree can go from clean to
  // dirty — a concurrent scratch probe, an edit landing in another pane of
  // the same worktree. `checkWorktreeClean()` runs again immediately before
  // both of those, which this one call cannot cover on its own.
  const earlyCleanRc = await checkWorktreeClean(head);
  if (earlyCleanRc !== 0) return earlyCleanRc;

  // Idempotent per head: a driver re-run, or a resumed session, must not
  // stack announcements on the same SHA.
  const marker = `<!-- drive-pr-merge-ready: ${head} -->`;

  // The head the gate above confirmed live must be the head the status call
  // describes; the pre-POST read covers any drift after this point.
  if (live.head !== head) {
    fail(
      4,
      `announce-merge-ready: PR #${pr} advanced from ${head} to ${live.head} while this ran.`,
      `Everything above describes ${head}, so nothing here can speak for the live head.`,
      "Re-run once the new head has settled.",
    );
  }

  // The sweep runs AFTER the cleanup, so it can never name a comment the
  // cleanup has just deleted — which would otherwise exit 0 reporting
  // "already announced" about a comment that no longer exists.
  const sweep = await announcements(pr, TRUSTED_ASSOCIATIONS);
  if (sweep === null) {
    fail(
      1,
      `announce-merge-ready: cannot read PR #${pr}'s comments — refusing to announce`,
      "on an unknown state, since a duplicate announcement cannot be unposted.",
    );
  }
  const existingIds = announcedIds(sweep, head);

  async function confirmFinalCi(staleIds: number[] = []): Promise<number> {
    const rc = await finalCiProof();
    if (!dryRun && rc === 4) {
      for (const id of staleIds) {
        const del = await ghCall(
          ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`],
          { stdout: "ignore", stderr: "inherit" },
        );
        if (del.code !== 0) return del.code;
      }
    }
    return rc === 5 ? 5 : rc === 0 ? 0 : 1;
  }

  // CONVERGED is a claim about the posting reviewer (`docomply-review`), which
  // reviews drafts — it says nothing about CodeRabbit, which refuses one
  // outright (§ Drafts are driven, SKILL.md). A still-draft PR reaching here
  // is exactly the false terminal `drive.ts` itself now refuses to report as
  // exit 0 (docomply-review round 6, a reference-implementation pull request, and the same gap one script
  // over): announcing "safe to merge" about a PR CodeRabbit has never seen,
  // and by repo policy never will until a human or a drive marks it Ready, is
  // the claim this script exists to avoid overstating.
  //
  // Handled by `checkLiveState()` below, not a bespoke up-front check here —
  // there used to be one, keyed on `status.draft` from the `drive-status.ts`
  // read at the top of this function. Moving it after `existingIds` (round
  // 16) fixed the missing withdrawal but not the deeper problem: `status` is
  // captured before the comment sweep and worktree checks that follow it, all
  // real elapsed time, so a human marking the PR Ready in that exact window
  // left `status.draft` stale — true when the announcement it was about to
  // delete had already become valid again (docomply-review round 18, PR
  // #4057). `checkLiveState()` is the fresh read this needs, and it already
  // runs next — folding this case into it rather than keeping a second, worse
  // copy of the same question.
  //
  // Re-read the head + mergeability now, BEFORE deciding "nothing to do" —
  // not just before posting. The CONVERGED gate above is a mergeability gate
  // too (drive-status.ts tests the conflict branch before the convergence
  // one), but only as of the moment IT ran; the comment sweep above is itself
  // a real API round-trip, and a base that advances in that window can flip
  // this PR to CONFLICTING while the head stays put. The idempotence path
  // used to return "nothing to do" on that stale read, leaving an
  // already-posted "Safe to merge" live and wrong (chatgpt-codex-connector,
  // a reference-implementation pull request round 10). Checking here means a stale existing announcement
  // gets withdrawn instead of left standing.
  let liveConfirmedConflicting = false;
  // Mirrors `liveConfirmedConflicting`: set only on a POSITIVELY parsed
  // `isDraft === true`, never on the type-invalid case just above it (that
  // one refuses for a different reason — "cannot confirm" is not "confirmed
  // draft" — and must not drive a withdrawal on evidence this weak).
  let liveConfirmedDraft = false;
  // A positive ci:hold read invalidates an existing same-head announcement
  // just as conclusively as a draft or conflict transition does.
  let liveConfirmedHeld = false;
  async function checkLiveState(): Promise<number> {
    // Reset on every call (this function runs several times) so a stale flag
    // from an earlier call never survives into a call that failed for an
    // unrelated reason (unreadable, head moved, PR closed).
    liveConfirmedConflicting = false;
    liveConfirmedDraft = false;
    liveConfirmedHeld = false;
    const r = await ghCall(
      [
        "pr",
        "view",
        pr,
        "--json",
        "state,headRefOid,mergeable,mergeStateStatus,isDraft,labels",
      ],
      { stderr: "ignore" },
    );
    let parsed: Record<string, unknown> | null = null;
    if (r.code === 0) {
      try {
        parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (parsed === null) {
      console.error(`announce-merge-ready: cannot re-read PR #${pr}'s head.`);
      console.error(
        "Refusing to act on a head this script can no longer confirm.",
      );
      return 1;
    }
    const liveHead = String(parsed.headRefOid ?? "");
    if (liveHead === "") {
      console.error(`announce-merge-ready: cannot re-read PR #${pr}'s head.`);
      console.error(
        "Refusing to act on a head this script can no longer confirm.",
      );
      return 1;
    }
    // Checked before mergeability: `headRefOid,mergeable` alone cannot tell a
    // merged/closed PR from an open one — the head can stay put and
    // `mergeable` can still read MERGEABLE after a merge, and both checks
    // would then pass on a finished PR (docomply-review, a reference-implementation pull request round 12).
    //
    // Anything other than the literal `OPEN` refuses (docomply-review, PR
    // #3995 round 13) — but NOT all with the same code. Exit 5 is the shared
    // PR_NOT_OPEN contract elsewhere in this skill and asserts the PR is
    // POSITIVELY known finished; reusing it for an empty/malformed `state`
    // would claim that certainty for a read that only proves itself
    // unreadable — a weaker claim this script's own withdrawal guard already
    // treats differently for `mergeable` (docomply-review, a reference-implementation pull request round
    // 14). Recognized terminal values get 5; anything else — empty, or a
    // value GitHub hasn't published for this field — is indeterminate and
    // gets 1, same as the unreadable-response branch just above.
    const livePrState = String(parsed.state ?? "");
    if (livePrState !== "OPEN") {
      if (livePrState === "MERGED" || livePrState === "CLOSED") {
        console.error(
          `announce-merge-ready: PR #${pr} is ${livePrState} — refusing to act on a finished PR.`,
        );
        return 5;
      }
      console.error(
        `announce-merge-ready: PR #${pr}'s state read as '${livePrState === "" ? "<empty>" : livePrState}' — not a recognized value, cannot confirm it is still OPEN.`,
      );
      return 1;
    }
    if (liveHead !== head) {
      console.error(
        `announce-merge-ready: PR #${pr} advanced from ${head} to ${liveHead} while this ran.`,
      );
      console.error(
        `Everything above describes ${head}, so acting now would vouch for a head`,
      );
      console.error(
        "nothing here reviewed. Re-run once the new head has settled.",
      );
      return 4;
    }
    const labels = parsed.labels;
    if (!Array.isArray(labels)) {
      console.error(
        `announce-merge-ready: PR #${pr}'s labels are unreadable — refusing to announce.`,
      );
      return 1;
    }
    let liveHeld = false;
    for (const label of labels) {
      if (typeof label !== "object" || label === null || Array.isArray(label)) {
        console.error(
          `announce-merge-ready: PR #${pr}'s labels are malformed — refusing to announce.`,
        );
        return 1;
      }
      const name = (label as Record<string, unknown>).name;
      if (typeof name !== "string" || name === "") {
        console.error(
          `announce-merge-ready: PR #${pr}'s labels are malformed — refusing to announce.`,
        );
        return 1;
      }
      if (name === "ci:hold") liveHeld = true;
    }
    if (liveHeld) {
      liveConfirmedHeld = true;
      console.error(
        "announce-merge-ready: 'ci:hold' appeared during the announcement check — refusing to act.",
      );
      return 4;
    }
    // Draftness is rechecked HERE too, not only in the up-front gate
    // (docomply-review round 14, a reference-implementation pull request): this function is what the sweep
    // and both idempotence-path checks call, and none of them previously
    // re-read `isDraft`. An owner converting the PR back to draft in the
    // window while the comment sweep or final checks run would otherwise
    // slip past every guard between the up-front gate and the POST (or the
    // idempotent "already announced" success), leaving or posting a "Safe to
    // merge" announcement that overrides the very signal — the PR is no
    // longer ready — that made it stop being true.
    //
    // TYPE VALIDATED, not merely `=== true` (docomply-review round 15, PR
    // #4057): this is decision evidence from an external response, the same
    // discipline `evaluate()` and `mark-ready.ts` already apply to `isDraft`.
    // An absent, null, or otherwise malformed value must NOT read as "not a
    // draft" — that is exactly the fail-open direction that would let a
    // partial/degraded response announce over a PR whose current draftness
    // this read could not actually confirm.
    if (typeof parsed.isDraft !== "boolean") {
      console.error(
        `announce-merge-ready: PR #${pr}'s isDraft read as '${parsed.isDraft === undefined ? "<absent>" : String(parsed.isDraft)}'`,
      );
      console.error(
        "  — not a boolean, so this cannot confirm the PR is currently Ready. Refusing to",
      );
      console.error(
        "  announce (or leave a standing announcement) on unconfirmed draftness.",
      );
      return 1;
    }
    if (parsed.isDraft === true) {
      liveConfirmedDraft = true;
      console.error(
        `announce-merge-ready: PR #${pr} is a draft again as of this re-read —`,
      );
      console.error(
        "  refusing to announce (or leave a standing announcement) on a PR that is not",
      );
      console.error(
        "  currently ready for external review. Re-run once it is Ready again.",
      );
      return 4;
    }
    const liveMergeable = String(parsed.mergeable ?? "").toUpperCase();
    const liveStateStatus = String(parsed.mergeStateStatus ?? "").toUpperCase();
    // A POSITIVELY PARSED `CONFLICTING`, never the broader "not MERGEABLE"
    // below. `UNKNOWN` (GitHub still recomputing) and an absent/malformed
    // value both fail the same `!= MERGEABLE` test but are NOT evidence the
    // PR conflicts — they are evidence GitHub has not settled or this read
    // was unreadable, and either can flip back to MERGEABLE seconds later.
    // Only this flag may drive a withdrawal; the broader test only ever
    // drives a refusal to POST.
    if (liveMergeable === "CONFLICTING") liveConfirmedConflicting = true;
    if (liveMergeable !== "MERGEABLE") {
      console.error(
        `announce-merge-ready: PR #${pr} is mergeable=${liveMergeable === "" ? "<unreadable>" : liveMergeable}${liveStateStatus !== "" ? ` (mergeStateStatus=${liveStateStatus})` : ""}.`,
      );
      console.error(
        "The review converged, but this announcement says SAFE TO MERGE and that is",
      );
      console.error(
        "not true unless GitHub says the PR is mergeable right now. Re-run once the",
      );
      console.error(
        "base is merged in (or once GitHub finishes recomputing, if UNKNOWN).",
      );
      return 4;
    }
    return 0;
  }

  // Withdraw only a confirmed case — same head, POSITIVELY parsed CONFLICTING
  // or POSITIVELY parsed `isDraft === true` — never on an unreadable state
  // (rc 1, could be transient), a closed PR (rc 5, nothing to correct), a
  // moved head (rc 4 with a different live head: that old announcement is
  // still an accurate claim about the head it names), or an
  // UNKNOWN/malformed mergeable (rc 4 but neither flag set: GitHub still
  // recomputing, or this specific read was bad — either can read MERGEABLE
  // again seconds later, and deleting on that evidence would erase a
  // still-valid announcement, contradicting this exact guard). `--dry-run`
  // never mutates GitHub regardless of any of the above (docomply-review, PR
  // #3995 round 12). Shared by every caller of `checkLiveState` that has some
  // standing announcement to reconsider — `ids` defaults to the pre-POST
  // `existingIds`, but the race-duplicate path passes the rival's surviving
  // id instead, since by the time it runs `existingIds` no longer names
  // what's actually standing — so the confirmed-vs-merely-refused distinction
  // is judged in one place regardless of whose comment it is (docomply-review
  // round 15, and the race-path extension in round 17, PR #4057).
  async function withdrawIfConfirmedStale(
    rc: number,
    ids: number[] = existingIds,
  ): Promise<number> {
    if (
      !dryRun &&
      rc === 4 &&
      (liveConfirmedConflicting || liveConfirmedDraft || liveConfirmedHeld) &&
      ids.length > 0
    ) {
      console.error(
        `announce-merge-ready: withdrawing now-stale announcement(s) on ${head} — ` +
          `${liveConfirmedHeld ? "ci:hold was applied" : liveConfirmedDraft ? "the PR is a draft again" : "mergeability changed"} after they were posted.`,
      );
      for (const id of ids) {
        const del = await ghCall(
          ["api", "-X", "DELETE", `repos/{owner}/{repo}/issues/comments/${id}`],
          { stdout: "ignore", stderr: "inherit" },
        );
        if (del.code !== 0) return del.code;
      }
    }
    return rc;
  }

  const liveRc = await checkLiveState();
  if (liveRc !== 0) {
    return await withdrawIfConfirmedStale(liveRc);
  }

  if (existingIds.length > 0) {
    // Re-confirm at the LAST moment before reporting success — with
    // `checkLiveState`, not `readLiveness` (docomply-review round 15, PR
    // #4057). The liveness read above happened before the retraction and
    // before this sweep, so the PR can have advanced H1→H2, flipped to
    // CONFLICTING, or gone back to draft in between — and `readLiveness`
    // (state+head only) confirms none of the last two, reporting the job
    // done on the strength of a claim ("mergeable", "Ready") this read never
    // actually re-checked. `checkLiveState` asks the same broader question
    // this function already asks everywhere else, and a confirmed
    // CONFLICTING or draft here withdraws the stale announcement instead of
    // leaving it standing, exactly like the top-of-function check above.
    const confirm = await checkLiveState();
    if (confirm !== 0) {
      return await withdrawIfConfirmedStale(confirm);
    }
    // Same re-check, for the same reason, on the tree rather than the PR: the
    // up-front cleanliness pass ran before the sweep, the liveness re-reads
    // above, and everything else this function has done since — any of which
    // is real elapsed time an edit can land in. Reporting "already announced"
    // over a tree that is no longer the one the up-front check saw is the
    // same false success as reporting it over a stale head.
    const lateCleanRc = await checkWorktreeClean(head);
    if (lateCleanRc !== 0) return lateCleanRc;
    const lateFinalCiRc = await confirmFinalCi(existingIds);
    if (lateFinalCiRc !== 0) return lateFinalCiRc;

    console.error(
      `announce-merge-ready: already announced for ${head} — nothing to do`,
    );
    return 0;
  }

  let body = `${OPENER}

The review drive converged on \`${short(head)}\`:

- \`${reviewer}\` completed its review of this exact head (reviewed-SHA verified via ${source})
- zero unresolved review threads
- zero unaddressed summary-only findings
- every non-reviewer check run completed \`success\`, \`neutral\` or \`skipped\`, and
  every commit status is \`success\` — a \`neutral\` or \`skipped\` run is treated as
  not-failing, which is weaker evidence than a pass

One thing the third bullet does NOT mean: a SUMMARY-ONLY finding answered
\`accepted\` or \`moot\` at this head rests on the driver's claim that the fix is
real, and no reviewer pass can have falsified it. The reviewer re-emits a
carried-forward finding at every head, including this one — but a fix-dependent
marker naming the head the reviewer is sitting on is honoured for exactly one
head, which is what stops it being inert on arrival, and that same grace is what
makes the re-emission unable to contradict it here. No local check closes the
gap: a code commit that does not really fix the finding reaches this point by
the identical path as a PR-description edit.

An inline THREAD answered the same way is not in that position. Its reply
precedes the push, the reviewer then completes on the pushed head, and a fix
that did not hold comes back as fresh unresolved work with no marker to suppress
it — which the second bullet would then not be able to report. That is a
reviewer pass over the fix, not proof of it: the reviewer may stay silent for
reasons that have nothing to do with the change.

The reasoning for every answer is in its own outcome comment on this PR; that is
the artefact to read back if a finding matters.

Merging it remains a human decision — the driver marks a converged PR Ready
for review itself (after its first round, or here if it converged before
running one), so this is the driver reporting that it has nothing left to do,
not an approval.`;

  if (followups.replace(/\s/g, "") !== "") {
    body += `

## Suggested follow-ups

${followups}`;
  }

  body += `

${marker}`;

  if (dryRun) {
    // Same re-check once more, this time before the dry-run success return:
    // `--dry-run` never posts, but it is still a success return, and
    // everything since the up-front pass (the sweep, the liveness re-reads,
    // body construction itself) is elapsed time an edit can land in.
    // Printing "here is what would be announced" over a tree that no longer
    // matches the up-front check is the same false success as posting it for
    // real would be (docomply-review, a reference-implementation pull request review round 2, summary
    // finding).
    //
    // State before tree, matching every other guard pair in this function —
    // including `isDraft`, not just mergeability (docomply-review round 15,
    // a reference-implementation pull request, summary finding): a Ready→draft conversion in the same
    // window is exactly what the withdrawal guards elsewhere in this
    // function exist for, and `--dry-run` reporting "would announce" on a
    // now-draft PR is the same stale-eligibility mistake as posting for
    // real would be.
    const preDryRunLiveRc = await checkLiveState();
    if (preDryRunLiveRc !== 0) return preDryRunLiveRc;
    const preDryRunCleanRc = await checkWorktreeClean(head);
    if (preDryRunCleanRc !== 0) return preDryRunCleanRc;
    const preDryRunFinalCiRc = await confirmFinalCi();
    if (preDryRunFinalCiRc !== 0) return preDryRunFinalCiRc;
    process.stdout.write(`${body}\n`);
    return 0;
  }

  // Re-check the head one more time, immediately before posting. The
  // `checkLiveState` above already covered the idempotence decision;
  // composing the body and the dry-run branch open a second, smaller window
  // after that, and this is the narrowest point left to close it before a new
  // comment actually gets written (docomply-review, a reference-implementation pull request round 7).
  // Nothing was posted yet on this path, so a failure here is a plain refusal
  // — there is no announcement to withdraw.
  const prePostRc = await checkLiveState();
  if (prePostRc !== 0) return prePostRc;

  // Same reasoning as the head re-check just above, for the tree rather than
  // the PR: body construction and the dry-run branch are further elapsed time
  // since the up-front cleanliness pass, and this is the narrowest point left
  // to close that window before a real comment gets written. Nothing was
  // posted yet, so a failure here is a plain refusal.
  const prePostCleanRc = await checkWorktreeClean(head);
  if (prePostCleanRc !== 0) return prePostCleanRc;
  const prePostFinalCiRc = await confirmFinalCi();
  if (prePostFinalCiRc !== 0) return prePostFinalCiRc;

  const post = await ghCall(
    ["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--input", "-"],
    { stdin: JSON.stringify({ body }), stderr: "inherit" },
  );
  if (post.code !== 0) return post.code;
  let posted: Record<string, unknown>;
  try {
    posted = JSON.parse(post.stdout) as Record<string, unknown>;
  } catch {
    posted = {};
  }
  const postedId = Number(posted.id ?? 0);
  // A comment is LIVE on the PR at this point. Without its id, every mechanism
  // that follows targets comment 0: `withdrawPosted` DELETEs a non-existent
  // comment, so the post-write fail-closed withdrawal silently cannot retract
  // the real one; the duplicate reconciliation compares `lowest !== postedId`,
  // which is always true, so it deletes 0 and leaves two announcements standing
  // (coderabbitai, PR #4034 round 2). This script's stated posture — withdraw
  // THIS PROCESS'S OWN comment if the world moved — is unachievable from here,
  // so say so and name the artefact rather than proceed through it.
  if (!Number.isInteger(postedId) || postedId <= 0) {
    fail(
      1,
      `announce-merge-ready: POSTED an announcement for ${head} on PR #${pr}, but the`,
      "API response carried no usable comment id. This process can no longer withdraw",
      "its own comment, so neither the post-write recheck nor the duplicate",
      "reconciliation below can run. Inspect the PR by hand and delete the comment if",
      "the head has moved or the PR is no longer open.",
    );
  }

  // The check above is still check-then-act: the GET and the POST are
  // separate operations, so a push landing between them narrows the window
  // without closing it, and the reconciliation below only dedupes MARKER IDS
  // — two announcements for one head, not one announcement for a head nobody
  // reviewed.
  //
  // Closing it needs the only move available after an unconditional write:
  // re-read, and withdraw THIS PROCESS'S OWN comment if the world moved. The
  // withdrawal machinery already exists for the duplicate-announcement race,
  // and deleting by the posted id means it can never touch a comment written
  // by anyone else. Between the wrong announcement standing and a brief one
  // that is then retracted, the retraction is the honest artefact.
  //
  // Residual, stated rather than papered over: a reader who sees the comment
  // in the seconds before the withdrawal has still seen it, and a failed
  // DELETE leaves it standing — which is why that path says so loudly rather
  // than exiting 0. The post-write re-read below is held to the same
  // fail-closed posture as everything before it: an UNREADABLE confirmation
  // is not weaker evidence than a confirmed change, it is the same absence of
  // proof, so it withdraws and refuses exactly like one.
  async function withdrawPosted(): Promise<boolean> {
    const del = await ghCall(
      [
        "api",
        "-X",
        "DELETE",
        `repos/{owner}/{repo}/issues/comments/${postedId}`,
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    if (del.code === 0) return true;
    console.error(
      `announce-merge-ready: could NOT withdraw comment ${postedId} — it is still`,
    );
    console.error(`on PR #${pr}, vouching for ${head}. Delete it by hand.`);
    return false;
  }

  // The post-write re-read is `checkLiveState`, NOT `readLiveness`.
  //
  // `readLiveness` answers state and head only, and the comment's claim is
  // broader than both: a base branch that advances between the pre-POST check
  // and the POST flips this PR to CONFLICTING while the head stays exactly
  // where it was, so a state+head confirmation passes and leaves a "Safe to
  // merge" comment standing on a PR that no longer merges
  // (chatgpt-codex-connector, a reference-implementation pull request round 17). `checkLiveState` reads
  // mergeability in the same round-trip and is already the pre-POST gate, so
  // asking the same question on both sides of the write is one function
  // rather than two divergent copies of the predicate.
  //
  // EVERY non-zero return withdraws here, including the ones the PRE-POST
  // withdrawal guard deliberately refuses to act on (rc 1 unreadable, rc 4
  // with mergeable UNKNOWN/malformed). That is not a contradiction of that
  // guard — it is a different question. Pre-POST, a withdrawal deletes an
  // announcement some EARLIER run posted and may still be correct, so it
  // demands positively-parsed CONFLICTING. Here the target is this process's
  // own comment, written seconds ago; "cannot confirm" and "confirmed
  // changed" both fail the one claim it makes, and the cost of being wrong is
  // a re-run rather than a destroyed artefact. That is the same fail-closed
  // posture the unreadable-state branch has had since round 9.
  //
  // The exit codes are `checkLiveState`'s own, so a merged/closed PR still
  // exits 5 and a moved head still exits 4 — split, because a merge usually
  // leaves the head untouched and folding it into the retry class invites a
  // caller to wait for a new head that is not coming.
  const afterRc = await checkLiveState();
  if (afterRc !== 0) {
    console.error(
      `announce-merge-ready: posted, but PR #${pr} no longer confirms the claim above`,
    );
    console.error(
      `(see the reason immediately preceding) — withdrawing this announcement of ${head}.`,
    );
    if (!(await withdrawPosted())) return 1;
    return afterRc;
  }

  // Same question once more, on the tree rather than the PR: the POST is
  // itself a real round-trip, and an edit can land in the working directory
  // while it is in flight — the exact loss mode this whole guard exists to
  // close, now discovered on the far side of a write that already happened
  // (chatgpt-codex-connector, a reference-implementation pull request review round 1). withdrawPosted() is
  // the only response available after an unconditional write: this
  // process's own comment, deleted by its own id, never anyone else's —
  // between a wrong announcement standing and a brief one that gets
  // retracted, the retraction is the honest artefact, same as `afterRc`
  // above.
  const afterCleanRc = await checkWorktreeClean(head);
  if (afterCleanRc !== 0) {
    console.error(
      `announce-merge-ready: posted, but this worktree now holds uncommitted state —`,
    );
    console.error(`withdrawing this announcement of ${head}.`);
    if (!(await withdrawPosted())) return 1;
    return afterCleanRc;
  }
  const afterFinalCiRc = await confirmFinalCi();
  if (afterFinalCiRc !== 0) {
    if (!(await withdrawPosted())) return 1;
    return afterFinalCiRc;
  }

  // The check above is check-then-act, and GitHub offers no create-if-absent
  // for a comment: two drivers on one PR can both finish the sweep before
  // either posts, and both then announce. Serialising is not available, so
  // converge afterwards instead — comment ids are monotonic, so "the lowest
  // id carrying this marker wins, everyone else withdraws their OWN comment"
  // settles to exactly one announcement no matter how the two interleave, and
  // never touches a comment this process did not write.
  //
  // Residual, stated rather than papered over: if list-after-write lags for
  // BOTH drivers they each see only themselves and both survive. That is
  // strictly better than before and cannot be closed without a real lease.
  const reconcileSweep = await announcements(pr, TRUSTED_ASSOCIATIONS);
  if (reconcileSweep !== null) {
    const ids = announcedIds(reconcileSweep, head);
    const lowest = ids.at(0);
    if (lowest !== undefined && lowest !== postedId) {
      console.error(
        `announce-merge-ready: raced another driver on ${head} — withdrawing this duplicate`,
      );
      const del = await ghCall(
        [
          "api",
          "-X",
          "DELETE",
          `repos/{owner}/{repo}/issues/comments/${postedId}`,
        ],
        { stdout: "ignore", stderr: "inherit" },
      );
      if (del.code !== 0) return del.code;
      // Our own duplicate is gone — the rival's announcement is what stands.
      // This process wrote none of its content, but "leaves nothing on the
      // floor" is a claim about the PR's actual state, not just about this
      // process's own artefacts, and the DELETE above was itself a real
      // round-trip an edit could have landed during — so it is re-checked
      // like every other exit-0 in this function, one last time
      // (chatgpt-codex-connector, a reference-implementation pull request review round 2).
      //
      // State before tree, same as everywhere else — including `isDraft`
      // (docomply-review round 15, a reference-implementation pull request, summary finding) — and on a
      // confirmed answer this now withdraws the RIVAL's surviving comment
      // too, not merely refuses (docomply-review round 17, a reference-implementation pull request): a
      // confirmed draft must not retain a standing announcement, whoever
      // posted it, so `withdrawIfConfirmedStale` runs against `[lowest]` —
      // what's actually standing at this point — rather than the pre-POST
      // `existingIds`, which named nothing here (the rival's comment did not
      // exist yet when that sweep ran).
      const raceLiveRc = await withdrawIfConfirmedStale(
        await checkLiveState(),
        [lowest],
      );
      if (raceLiveRc !== 0) return raceLiveRc;
      const raceCleanRc = await checkWorktreeClean(head);
      if (raceCleanRc !== 0) return raceCleanRc;
      const raceFinalCiRc = await confirmFinalCi([lowest]);
      if (raceFinalCiRc !== 0) return raceFinalCiRc;
      return 0;
    }
  } else {
    console.error(
      "announce-merge-ready: posted, but could not re-read comments to check for a",
    );
    console.error(
      "concurrent duplicate — verify by eye if two drivers may have been running.",
    );
  }

  // The LAST possible point before the last possible success return: the
  // reconciliation sweep just above is itself a real round-trip, and this is
  // the narrowest window left to close before reporting the announcement — by
  // now confirmed OURS — as done. Unlike the race branch above, our own
  // comment IS the one standing here, so anything the state check below
  // catches means withdrawing it, same as `afterRc` right after the POST.
  //
  // State before tree, matching every other guard pair in this function
  // (`prePostRc`/`prePostCleanRc`, `afterRc`/`afterCleanRc`) — `isDraft`
  // included, not just mergeability, because the reconciliation sweep is a
  // real round-trip an owner's Ready→draft conversion can land in exactly
  // like any other (docomply-review round 15, a reference-implementation pull request).
  const finalLiveRc = await checkLiveState();
  if (finalLiveRc !== 0) {
    console.error(
      `announce-merge-ready: posted, but PR #${pr} no longer confirms the claim above`,
    );
    console.error(
      `(see the reason immediately preceding) — withdrawing this announcement of ${head}.`,
    );
    if (!(await withdrawPosted())) return 1;
    return finalLiveRc;
  }

  // Same reasoning as the state check above, for the tree rather than the PR.
  const finalCleanRc = await checkWorktreeClean(head);
  if (finalCleanRc !== 0) {
    console.error(
      `announce-merge-ready: posted, but this worktree now holds uncommitted state —`,
    );
    console.error(`withdrawing this announcement of ${head}.`);
    if (!(await withdrawPosted())) return 1;
    return finalCleanRc;
  }
  const finalFinalCiRc = await confirmFinalCi();
  if (finalFinalCiRc !== 0) {
    if (!(await withdrawPosted())) return 1;
    return finalFinalCiRc;
  }

  process.stdout.write(`${String(posted.html_url ?? "")}\n`);
  return 0;
}

runMain("announce-merge-ready.ts", main);

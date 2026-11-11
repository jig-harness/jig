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
 * must be exactly `green` AND the reviewers that skip drafts must have run on
 * the head since it was marked Ready (`lib/announce-draft-skippers.ts`) AND
 * this worktree must be clean. That verdict
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

import { checkWorktreeClean } from "./lib/announce-clean.ts";
import {
  draftSkippersRan,
  withdrawIfSkippersPending,
} from "./lib/announce-draft-skippers.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Announcement,
  announcedIds,
  announcements,
  announcementsOf,
  headMarker,
  OPENER,
  postAnnouncement,
  readAnnouncement,
  unreadableNote,
  withdrawAnnouncement,
} from "./lib/announce.ts";
import { APPROVAL_WARNING } from "./lib/announce-wording.ts";
import {
  laneHolds,
  readyOrWithdraw,
  reconcileStanding,
} from "./lib/announce-ready.ts";
import { parsePrSnapshot } from "./lib/ci-hold.ts";
import { ciHoldLabelSetting } from "./lib/overlay.ts";

/** How messages name the repository's CI-hold label. */
const holdName = (): string => ciHoldLabelSetting() ?? "CI hold";
import { fail, isDigits, readStdinAll, runMain, short } from "./lib/cli.ts";
import { reviewedClaim } from "./lib/status/reviewed-sha.ts";
import {
  ciHoldTimeoutSeconds,
  ghCall,
  git,
  readTimeoutEnv,
  resolvePr,
  run,
  tsArgv,
} from "./lib/proc.ts";

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
    const parsed = parsePrSnapshot(
      JSON.parse(r.stdout) as unknown,
      ciHoldLabelSetting() ?? null,
    );
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

/** Stop over trusted announcements that name no head: none can be told from a standing one, so none is guessed at. */
function refuseUnreadable(all: Announcement[], when: string): void {
  const note = unreadableNote(all);
  if (note !== null) {
    fail(
      1,
      `announce-merge-ready: announcements naming no head, ${when}: ${note} — remove or repair them by hand.`,
    );
  }
}

/** What to say before withdrawing an announcement the live state no longer backs. */
function withdrawNote(
  failed: "state" | "tree" | "ci" | null,
  pr: string,
  head: string,
): string[] {
  if (failed === "state")
    return [
      `announce-merge-ready: posted, but PR #${pr} no longer confirms the claim above`,
      `(see the reason immediately preceding) — withdrawing this announcement of ${head}.`,
    ];
  if (failed === "tree")
    return [
      "announce-merge-ready: posted, but this worktree now holds uncommitted state —",
      `withdrawing this announcement of ${head}.`,
    ];
  return [];
}

/** The draft-skipper gate's refusal as an exit code, and whether it positively said `not-yet`. */
async function skippersGate(
  pr: string,
  head: string,
): Promise<{ rc: number; pending: boolean }> {
  const skippers = await draftSkippersRan(pr, head);
  if (skippers.ok) return { rc: 0, pending: false };
  const notYet = skippers.failure.code === "not-yet";
  console.error(
    `announce-merge-ready: ${skippers.failure.reason} — refusing to announce${notYet ? "; re-run once it has run on the Ready pull request" : ""}`,
  );
  return { rc: notYet ? 4 : 1, pending: notYet };
}

/** Why a standing announcement is stale, from the positively confirmed live facts; null when none. */
function staleCause(f: {
  held: boolean;
  draft: boolean;
  skippers: boolean;
  conflicting: boolean;
}): string | null {
  if (f.held) return `${holdName()} was applied`;
  if (f.draft) return "the PR is a draft again";
  if (f.skippers)
    return "the draft-skipping reviewers have not run since it was marked Ready";
  return f.conflicting ? "mergeability changed" : null;
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
    const all = await announcements(pr);
    if (all === null) return;
    for (const { id, head: sha, unreadable } of all) {
      // An announcement that names no head is not guessed at: the final
      // sweep refuses over it.
      if (unreadable !== undefined) continue;
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
      if (!(await withdrawAnnouncement(pr, id))) {
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
      const standing = await announcements(pr);
      if (standing === null) {
        fail(
          1,
          `announce-merge-ready: cannot read PR #${pr}'s comments while ${holdName()} is present — remove any standing merge-ready announcement by hand.`,
        );
      }
      for (const id of announcedIds(standing, live.head)) {
        if (!(await withdrawAnnouncement(pr, id))) {
          fail(
            1,
            `announce-merge-ready: could not withdraw held-head announcement ${id} — remove it by hand.`,
          );
        }
      }
      // After the withdrawals: a malformed announcement is left for manual
      // repair, but it must not keep a readable stale one standing.
      refuseUnreadable(standing, `while ${holdName()} is present`);
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
    if (!dryRun) await withdrawIfSkippersPending(pr, live.head);
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
      `announce-merge-ready: review converged, but '${holdName()}' is still present. The drive must release its owned transition and establish full CI before this read-only announcer can proceed.`,
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
  // up-front clean check below, so that check can compare local HEAD against it
  // too. Pure extraction from data already in hand; no new I/O.
  const head = convergedHead;
  const reviewer = String(
    (status.reviewer as Record<string, unknown>)?.app ?? "",
  );
  const source = String(
    (status.reviewer as Record<string, unknown>)?.reviewedShaSource ?? "",
  );
  // A head the reviewer skipped is certified by its review of an earlier one.
  const reviewedWhat = reviewedClaim(
    source,
    String((status.reviewer as Record<string, unknown>)?.reviewedSha ?? ""),
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
    // `drive-status.ts` after every `final-ready` call. Without it, a required
    // check rerun and failed after the single aggregate-status snapshot taken
    // at the top of this script (`ci !== 'green'`, above) stays invisible for
    // the rest of the run — see `finalReady`'s own doc comment in ci-hold.ts
    // for why this is opt-in rather than the default for every caller.
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
      const standing = await announcements(pr);
      if (standing === null) {
        fail(
          1,
          `announce-merge-ready: final CI proof is stale and same-head announcements could not be enumerated; inspect PR #${pr} manually.`,
        );
      }
      for (const id of announcedIds(standing, head)) {
        if (!(await withdrawAnnouncement(pr, id))) {
          fail(
            1,
            `announce-merge-ready: final CI proof is stale, but comment ${id} could not be withdrawn; remove it manually.`,
          );
        }
      }
      refuseUnreadable(standing, "as the final CI proof is stale");
    }
    fail(
      finalCi === 5 ? 5 : finalCi === 4 ? 4 : 1,
      `announce-merge-ready: final CI/${holdName()} evidence is stale or unreadable (exit ${finalCi})`,
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
  const marker = headMarker(head);

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
  const sweep = await announcements(pr);
  if (sweep === null) {
    fail(
      1,
      `announce-merge-ready: cannot read PR #${pr}'s comments — refusing to announce`,
      "on an unknown state, since a duplicate announcement cannot be unposted.",
    );
  }
  refuseUnreadable(sweep, "before announcing");
  const existingIds = announcedIds(sweep, head);

  async function confirmFinalCi(staleIds: number[] = []): Promise<number> {
    const rc = await finalCiProof();
    if (!dryRun && rc === 4) {
      for (const id of staleIds)
        if (!(await withdrawAnnouncement(pr, id))) return 1;
    }
    return rc === 5 ? 5 : rc === 0 ? 0 : 1;
  }

  // CONVERGED is a claim about the posting reviewer, which reviews drafts; a
  // reviewer that skips drafts has not seen one, so a draft is refused here.
  // `checkLiveState()` re-reads `isDraft` each time it runs, since a person
  // can mark the PR Ready or draft again while the checks below run.
  //
  // Re-read the head + mergeability now, BEFORE deciding "nothing to do" — not
  // just before posting. The CONVERGED gate above is a mergeability gate too
  // (drive-status.ts tests the conflict branch before the convergence one), but
  // only as of the moment IT ran; the comment sweep above is itself a real API
  // round-trip, and a base that advances in that window can flip this PR to
  // CONFLICTING while the head stays put. The idempotence path used to return
  // "nothing to do" on that stale read, leaving an already-posted "Safe to
  // merge" live and wrong. Checking here means a stale existing announcement
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
  // Set only on a positive `not-yet` from the draft-skipper gate, never on an
  // unreadable timeline or check-run read.
  let liveConfirmedSkippersPending = false;
  async function checkLiveState(): Promise<number> {
    // Reset on every call (this function runs several times) so a stale flag
    // from an earlier call never survives into a call that failed for an
    // unrelated reason (unreadable, head moved, PR closed).
    liveConfirmedConflicting = false;
    liveConfirmedDraft = false;
    liveConfirmedHeld = false;
    liveConfirmedSkippersPending = false;
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
    // would then pass on a finished PR.
    //
    // Anything other than the literal `OPEN` refuses — but NOT all with the
    // same code. Exit 5 is the shared PR_NOT_OPEN contract elsewhere in this
    // skill and asserts the PR is POSITIVELY known finished; reusing it for an
    // empty/malformed `state` would claim that certainty for a read that only
    // proves itself unreadable — a weaker claim this script's own withdrawal
    // guard already treats differently for `mergeable`. Recognized terminal
    // values get 5; anything else — empty, or a value GitHub hasn't published
    // for this field — is indeterminate and gets 1, same as the
    // unreadable-response branch just above.
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
      if (name === ciHoldLabelSetting()) liveHeld = true;
    }
    if (liveHeld) {
      liveConfirmedHeld = true;
      console.error(
        `announce-merge-ready: '${holdName()}' appeared during the announcement check — refusing to act.`,
      );
      return 4;
    }
    // Draftness is rechecked HERE too, not only in the up-front gate: this
    // function is what the sweep and both idempotence-path checks call, and
    // none of them previously re-read `isDraft`. An owner converting the PR
    // back to draft in the window while the comment sweep or final checks run
    // would otherwise slip past every guard between the up-front gate and the
    // POST (or the idempotent "already announced" success), leaving or posting
    // a "Safe to merge" announcement that overrides the very signal — the PR is
    // no longer ready — that made it stop being true.
    //
    // TYPE VALIDATED, not merely `=== true`: this is decision evidence from an
    // external response, the same discipline `evaluate()` and `mark-ready.ts`
    // already apply to `isDraft`. An absent, null, or otherwise malformed value
    // must NOT read as "not a draft" — that is exactly the fail-open direction
    // that would let a partial/degraded response announce over a PR whose
    // current draftness this read could not actually confirm.
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
    // The reviewers that skip drafts must have run since the Ready mark. It
    // is asked here, with the other live facts, because a person can convert
    // the PR to draft and back to Ready on the same head at any point of the
    // run, and only a read taken after that transition sees it.
    const skippers = await skippersGate(pr, head);
    liveConfirmedSkippersPending = skippers.pending;
    if (skippers.rc !== 0) return skippers.rc;
    return 0;
  }

  // Withdraw only a confirmed case — same head, POSITIVELY parsed CONFLICTING
  // or POSITIVELY parsed `isDraft === true` — never on an unreadable state (rc
  // 1, could be transient), a closed PR (rc 5, nothing to correct), a moved
  // head (rc 4 with a different live head: that old announcement is still an
  // accurate claim about the head it names), or an UNKNOWN/malformed mergeable
  // (rc 4 but neither flag set: GitHub still recomputing, or this specific read
  // was bad — either can read MERGEABLE again seconds later, and deleting on
  // that evidence would erase a still-valid announcement, contradicting this
  // exact guard). `--dry-run` never mutates GitHub regardless of any of the
  // above. Shared by every caller of `checkLiveState` that has some standing
  // announcement to reconsider — `ids` defaults to the pre-POST `existingIds`,
  // but the race-duplicate path passes the rival's surviving id instead, since
  // by the time it runs `existingIds` no longer names what's actually standing
  // — so the confirmed-vs-merely-refused distinction is judged in one place
  // regardless of whose comment it is.
  async function withdrawIfConfirmedStale(
    rc: number,
    ids: number[] = existingIds,
  ): Promise<number> {
    const cause = staleCause({
      held: liveConfirmedHeld,
      draft: liveConfirmedDraft,
      skippers: liveConfirmedSkippersPending,
      conflicting: liveConfirmedConflicting,
    });
    if (!dryRun && rc === 4 && cause !== null && ids.length > 0) {
      console.error(
        `announce-merge-ready: withdrawing now-stale announcement(s) on ${head} — ${cause} after they were posted.`,
      );
      for (const id of ids) if (!(await withdrawAnnouncement(pr, id))) return 1;
    }
    return rc;
  }

  const liveRc = await checkLiveState();
  if (liveRc !== 0) {
    return await withdrawIfConfirmedStale(liveRc);
  }
  // The Ready predicate adds the forge's protection and review requirements.
  const forge = await readyOrWithdraw(pr, head, dryRun ? [] : existingIds);
  if (forge.rc !== 0) return forge.rc;

  if (existingIds.length > 0) {
    // Re-confirm at the LAST moment before reporting success — with
    // `checkLiveState`, not `readLiveness`. The liveness read above happened
    // before the retraction and before this sweep, so the PR can have advanced
    // H1→H2, flipped to CONFLICTING, or gone back to draft in between — and
    // `readLiveness` (state+head only) confirms none of the last two, reporting
    // the job done on the strength of a claim ("mergeable", "Ready") this read
    // never actually re-checked. `checkLiveState` asks the same broader
    // question this function already asks everywhere else, and a confirmed
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

    const wordingRc = await reconcileStanding(pr, head, existingIds, dryRun);
    if (wordingRc !== 0) return wordingRc;
    const reconciledCleanRc = await checkWorktreeClean(head);
    if (reconciledCleanRc !== 0) return reconciledCleanRc;
    console.error(
      `announce-merge-ready: already announced for ${head} — nothing to do`,
    );
    return 0;
  }

  // What the reviewer's evidence is depends on its source: a head the reviewer
  // skipped had no pass of its own, so the paragraphs on its re-emission and on
  // a pass over a fix do not apply to it.
  const reviewerEvidence =
    source === "skip-notice"
      ? `One thing the third bullet does NOT mean: no reviewer pass ran on this head.
It skipped this head, and its earlier review stands for it only because the
pull request's diff is the same at both. Any finding answered \`accepted\` or
\`moot\` at this head, inline thread or summary-only, rests on the driver's
claim that the fix is real, and nothing the reviewer did on this head can have
falsified it.`
      : `One thing the third bullet does NOT mean: a SUMMARY-ONLY finding answered
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
reasons that have nothing to do with the change.`;

  let text = `
The review drive converged on \`${short(head)}\`:

- \`${reviewer}\` ${reviewedWhat} (reviewed-SHA verified via ${source})
- zero unresolved review threads
- zero unaddressed summary-only findings
- every non-reviewer check run completed \`success\`, \`neutral\` or \`skipped\`, and
  every commit status is \`success\` — a \`neutral\` or \`skipped\` run is treated as
  not-failing, which is weaker evidence than a pass

${reviewerEvidence}

The reasoning for every answer is in its own outcome comment on this PR; that is
the artefact to read back if a finding matters.

${forge.lane === "approve-first" ? APPROVAL_WARNING : ""}Merging it remains a human decision — unless the repository marks Ready
never, the driver marks a converged PR Ready for review itself (after the
round the repository declares, or here if it converged before reaching it),
so this is the driver reporting that it has nothing left to do, not an
approval.`;

  if (followups.replace(/\s/g, "") !== "") {
    text += `

## Suggested follow-ups

${followups}`;
  }

  text += `

${marker}`;

  // The merge-readiness predicate: the PR's live state, then the tree, then
  // the final CI proof, each read afresh, and the first that fails answers.
  // The dry-run return and the post itself sit behind it. The two paths that
  // answer without posting (an announcement of this head already standing,
  // and a lost race) run the same three checks inline, each with its own
  // withdrawal policy, so a check added here must be added to them too.
  async function mergeReady(): Promise<{
    rc: number;
    failed: "state" | "tree" | "ci" | null;
  }> {
    const checks = [
      ["state", checkLiveState],
      ["state", () => laneHolds(pr, head, forge.lane)],
      ["tree", () => checkWorktreeClean(head)],
      ["ci", () => confirmFinalCi()],
    ] as const;
    for (const [failed, check] of checks) {
      const rc = await check();
      if (rc !== 0) return { rc, failed };
    }
    return { rc: 0, failed: null };
  }

  if (dryRun) {
    // Asked once more before the dry-run success return: `--dry-run` never
    // posts, but it is still a success return, and everything since the
    // up-front pass (the sweep, the liveness re-reads, body construction
    // itself) is elapsed time an edit, a Ready→draft conversion or a base
    // advance can land in. Reporting "would announce" then is the same false
    // success as posting would be.
    const { rc: dryRunRc } = await mergeReady();
    if (dryRunRc !== 0) return dryRunRc;
    process.stdout.write(`${OPENER}\n${text}\n`);
    return 0;
  }

  // Asked one more time immediately before posting. The `checkLiveState`
  // above already covered the idempotence decision; composing the body and
  // the dry-run branch open a second, smaller window after that, and this is
  // the narrowest point left to close it before a comment gets written.
  // Nothing was posted yet on this path, so a failure here is a plain
  // refusal — there is no announcement to withdraw.
  const { rc: prePostRc } = await mergeReady();
  if (prePostRc !== 0) return prePostRc;

  // The announce posts only inside its claim: the comment is a claim on this
  // head (`lib/announce.ts`, through the shared forge-claims module), posted
  // only while `mergeReady` holds, and it stands only once the read-back
  // shows it the earliest trusted announcement of the head and `mergeReady`
  // still holds. Every other outcome withdraws it.
  const published = await postAnnouncement(pr, head, text);
  if (!published.ok) {
    // A comment without a usable id may be LIVE on the PR, and nothing
    // after this point can withdraw a comment it cannot name.
    if (published.failure.code === "no-comment-id")
      fail(
        1,
        `announce-merge-ready: POSTED an announcement for ${head} on PR #${pr}, but ${published.failure.reason}.`,
        "This process can no longer withdraw its own comment, so neither the post-write",
        "recheck nor the duplicate reconciliation below can run. Inspect the PR by hand",
        "and delete the comment if the head has moved or the PR is no longer open.",
      );
    console.error(
      `announce-merge-ready: could not post the announcement: ${published.failure.reason}`,
    );
    return 1;
  }
  const { id: postedId, url, posted } = published.value;

  // The checks before the post are check-then-act: the reads and the POST are
  // separate operations, so a push, a base advance, a Ready→draft conversion
  // or an edit in the working directory landing between them, or during the
  // POST itself, narrows the window without closing it. The only move left
  // after an unconditional write is to ask again, and withdraw THIS
  // PROCESS'S OWN comment, by its own id, if the answer changed. Every
  // non-zero answer withdraws here, including the ones the pre-post
  // withdrawal guard refuses to act on (an unreadable read, a mergeability
  // GitHub is still computing): that guard decides whether to delete an
  // announcement an EARLIER run posted and may still be correct, while this
  // one is this process's own comment, written seconds ago, and "cannot
  // confirm" fails its claim as surely as "confirmed changed". The exit codes
  // are the checks' own, so a merged PR still exits 5 and a moved head 4.
  //
  // Residual, stated rather than papered over: a reader who sees the comment
  // in the seconds before the withdrawal has still seen it, and a failed
  // DELETE leaves it standing, which is why that path says so loudly.
  async function withdrawPosted(): Promise<boolean> {
    if (await withdrawAnnouncement(pr, postedId)) return true;
    console.error(
      `announce-merge-ready: could NOT withdraw comment ${postedId} — it is still`,
    );
    console.error(`on PR #${pr}, vouching for ${head}. Delete it by hand.`);
    return false;
  }
  async function stillReady(): Promise<number> {
    const { rc, failed } = await mergeReady();
    if (rc === 0) return 0;
    for (const line of withdrawNote(failed, pr, head)) console.error(line);
    return (await withdrawPosted()) ? rc : 1;
  }

  const afterRc = await stillReady();
  if (afterRc !== 0) return afterRc;

  // GitHub offers no create-if-absent for a comment: two drivers on one PR
  // can both finish the sweep before either posts, and both then announce.
  // The claim settles it afterwards instead: the read-back weighs every
  // trusted announcement of this head, the earliest comment wins, and every
  // other driver withdraws its OWN comment, which settles to one
  // announcement however the two interleave and never touches a comment this
  // process did not write. A read-back that does not list this comment yet
  // reads again a few times; one that never lists it cannot say whether an
  // earlier announcement stands, so this one is withdrawn.
  //
  // Residual, stated rather than papered over: if the listing lags for BOTH
  // drivers past each one's read-back, each sees itself the earliest and
  // both survive. That cannot be closed without a conditional create.
  // The weighing below discards unreadable records, so a trusted announcement
  // naming no head that appeared during the POST is checked for here, and
  // this process's own comment is withdrawn before refusing.
  const after = await announcements(pr);
  const afterNote = after === null ? null : unreadableNote(after);
  if (afterNote !== null) {
    console.error(
      `announce-merge-ready: posted, but announcements naming no head now stand: ${afterNote} — withdrawing this announcement of ${head}; remove or repair them by hand.`,
    );
    await withdrawPosted();
    return 1;
  }
  const back = await readAnnouncement(pr, posted);
  if (back.ok && back.value.verdict === "lost") {
    console.error(
      `announce-merge-ready: posted, but ${back.value.reason}, so whether an earlier announcement of ${head} stands is unknown — withdrawing this one; re-run.`,
    );
    await withdrawPosted();
    return 1;
  }
  // The listing the weighing below used can differ from the sweep above (a
  // lagging page, a comment that landed between the two), so unreadable
  // trusted announcements are looked for in it too.
  const backNote = back.ok
    ? unreadableNote(announcementsOf(back.value.listing))
    : null;
  if (backNote !== null) {
    console.error(
      `announce-merge-ready: posted, but announcements naming no head stand in the read-back: ${backNote} — withdrawing this announcement of ${head}; remove or repair them by hand.`,
    );
    await withdrawPosted();
    return 1;
  }
  const lowest =
    back.ok && back.value.verdict === "lost-to" ? back.value.winner?.id : null;
  if (lowest !== undefined && lowest !== null) {
    console.error(
      `announce-merge-ready: raced another driver on ${head} — withdrawing this duplicate`,
    );
    if (!(await withdrawAnnouncement(pr, postedId))) return 1;
    // Our own duplicate is gone — the rival's announcement is what stands.
    // This process wrote none of its content, but "leaves nothing on the
    // floor" is a claim about the PR's actual state, not just about this
    // process's own artefacts, and the DELETE above was itself a real
    // round-trip an edit could have landed during — so it is re-checked
    // like every other exit-0 in this function, one last time.
    //
    // State before tree, same as everywhere else — including `isDraft` — and
    // on a confirmed answer this withdraws the RIVAL's surviving comment
    // too, not merely refuses: a confirmed draft must not retain a standing
    // announcement, whoever posted it, so `withdrawIfConfirmedStale` runs
    // against `[lowest]`, what is actually standing at this point, rather
    // than the pre-POST `existingIds`, which named nothing here (the rival's
    // comment did not exist yet when that sweep ran).
    const raceLiveRc = await withdrawIfConfirmedStale(await checkLiveState(), [
      lowest,
    ]);
    if (raceLiveRc !== 0) return raceLiveRc;
    const raceCleanRc = await checkWorktreeClean(head);
    if (raceCleanRc !== 0) return raceCleanRc;
    const raceFinalCiRc = await confirmFinalCi([lowest]);
    if (raceFinalCiRc !== 0) return raceFinalCiRc;
    const raceWordingRc = await reconcileStanding(pr, head, [lowest], false);
    if (raceWordingRc !== 0) return raceWordingRc;
    return await checkWorktreeClean(head);
  }
  if (!back.ok) {
    console.error(
      `announce-merge-ready: posted, but could not re-read comments to check for an earlier announcement of ${head} — withdrawing this one; re-run.`,
    );
    await withdrawPosted();
    return 1;
  }

  // The LAST possible point before the last possible success return: the
  // read-back just above is itself a real round-trip, and this is the
  // narrowest window left to close before reporting the announcement — by
  // now confirmed OURS — as done. Unlike the race branch above, our own
  // comment IS the one standing here, so anything this catches means
  // withdrawing it, as right after the POST.
  const finalRc = await stillReady();
  if (finalRc !== 0) return finalRc;

  process.stdout.write(`${url}\n`);
  return 0;
}

runMain("announce-merge-ready.ts", main);

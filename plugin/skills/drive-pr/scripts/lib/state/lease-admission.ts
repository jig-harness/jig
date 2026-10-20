/** Admit one tree per PR and publish its session lease only while both admission conditions hold. */
import { resolveActor, worktreeRoot } from "./actor.ts";

import {
  resolveSession,
  leasePathFor,
  DRIVE_HELD_ELSEWHERE_EXIT,
  leaseStaleMin,
  type Session,
  type LeaseAdmission,
  type Lease,
  treeLeasePathFor,
  renewAfterMs,
} from "./lease-model.ts";

import {
  leaseForClaim,
  liveLeasesFor,
  isRecycledPid,
  unreadableLeaseFilesFor,
  leaseHolderLabel,
  ageLabel,
  leaseLivenessHint,
  readLease,
  leaseAlive,
  isMine,
  leaseFreshMarginMs,
} from "./lease-records.ts";

import { fail } from "../cli.ts";

import {
  claimSessionlessTreeLease,
  rollbackTreeLease,
  claimTreeLease,
} from "./lease-tree.ts";

import { prRemoteMutationLock, leaseLock } from "./lease-files.ts";

import {
  type PathLock,
  LOCK_ACQUIRE_MAX_SEC,
  LockAcquireTimeoutError,
  lockHeartbeatMs,
  createLock,
} from "./lock.ts";

import { join } from "node:path";

import { atomicWrite } from "./fsutil.ts";

/**
 * Refuse this claim when any OTHER working tree holds a live lease on this PR.
 *
 * Called only from inside the state-mutex hold, which is what makes it a gate
 * rather than a hint: every admission that could newly grant a tree the PR
 * takes that mutex, so enumerating under it serialises the decision. Two trees
 * starting at the same instant cannot both observe an empty set — the second to
 * take the mutex reads the first's lease, which the first wrote before
 * releasing it.
 *
 * Refuses on the FIRST foreign holder rather than reporting all of them: more
 * than one live foreign lease means the PR was already being driven from two
 * other trees, which this gate exists to make impossible going forward and
 * which `lease --all` is the surface for diagnosing. A refusal's job is to name
 * one holder precisely enough to act on.
 */
/**
 * `assertNoForeignDrive` for a caller that has not resolved an actor — the
 * no-session tier's admission FENCE.
 *
 * Exists because that tier holds no lease, so `assertLeaseUnchanged` has
 * nothing to compare and the ordinary fence cannot run. Installed by
 * `drive-state.ts` on the sessionless path, where it fires inside every locked
 * section with the state mutex held, which is what turns the preflight in
 * `claimLease` from a racy check into one continuous admission protocol.
 */
export async function assertNoForeignDriveNow(
  stateDir: string,
  pr: string,
): Promise<void> {
  assertNoForeignDrive(stateDir, pr, await resolveActor());
}

function assertNoForeignDrive(
  stateDir: string,
  pr: string,
  actor: string,
): void {
  // Resolved fresh rather than threaded in from a caller, so every entry
  // point — the tier-3 no-session fence, the standalone `admit` preflight,
  // and the tokened/tokenless call inside `claimLease`'s `underLocks` — gets
  // the SAME recycled-pid protection without a parameter every call site has
  // to remember to pass. Pure given a fixed environment, so re-deriving it
  // here agrees with whatever `claimLease` already resolved for this process.
  const session = resolveSession();
  const foreign = liveLeasesFor(stateDir, pr).filter(
    (l) => l.actor !== actor && !isRecycledPid(l, session, actor),
  );
  const l = foreign[0];
  if (l === undefined) {
    // Nothing READABLE is driving. Before admitting, account for the files this
    // gate could not read at all — otherwise "no live foreign lease" is a claim
    // about the subset that happened to parse, and a corrupted or
    // mixed-version live lease reads as an empty PR.
    //
    // This tree's OWN unreadable lease is excluded: `claimLease`'s locked path
    // is about to overwrite it, and refusing there would wedge a tree out of
    // its own PR over its own debris — recoverable only by deleting a file the
    // refusal would be telling it not to touch.
    const self = leasePathFor(stateDir, pr, actor);
    const unreadable = unreadableLeaseFilesFor(stateDir, pr).filter(
      (f) => f !== self,
    );
    if (unreadable.length === 0) return;
    fail(
      DRIVE_HELD_ELSEWHERE_EXIT,
      `drive-state.ts: PR #${pr} has ${unreadable.length} lease file(s) from another working tree that cannot be read as a lease.`,
      ...unreadable.map((f) => `  ${f}`),
      "",
      "Refusing to treat unreadable as absent. A lease file exists because some",
      "tree wrote one, so admitting this command would be a claim about the",
      "files that happened to parse — and being the second resolver on a PR",
      "double-replies every thread both reach.",
      "",
      `Read them to see whose they are. If they are debris, drive-state.ts clear-lease ${pr} --all`,
      `clears every tree's; otherwise they stop blocking on their own once ${leaseStaleMin()}m`,
      "pass without modification.",
    );
  }
  const where = l.worktree === "" ? l.actor : `${l.worktree} (${l.actor})`;
  fail(
    DRIVE_HELD_ELSEWHERE_EXIT,
    `drive-state.ts: PR #${pr} is already being driven from ANOTHER working tree — ${where}.`,
    `That tree is held by ${leaseHolderLabel(l)}; it took the lease at ${l.startedAt} and last mutated drive state ${ageLabel(l.lastSeen)} ('${l.command}').`,
    ...(foreign.length > 1
      ? [
          `(${foreign.length} live foreign leases in total — run 'drive-state.ts lease ${pr} --all' to see them.)`,
        ]
      : []),
    "",
    "Two resolvers on one PR put TWO outcome replies on every thread they both",
    "reach, which is not repairable once posted and corrupts the reviewer-scoring",
    "sample. Refusing to be the second.",
    "",
    "Nothing here stops this tree READING the drive: get, held, held-keys,",
    "parked-keys, verified, rounds and lease are all ungated. Only mutating this",
    "PR's drive state — which is the same thing as replying to its threads — is.",
    "",
    leaseLivenessHint(l),
    `If it is gone, or you are taking the PR over deliberately:  drive-state.ts clear-lease ${pr} --all`,
    `Otherwise the lease clears itself once that tree has left drive state`,
    `untouched for ${leaseStaleMin()}m, and this tree is admitted with no further action.`,
  );
}

/**
 * Take or renew this session's lease over (this working tree, this PR), or
 * refuse because another live session holds it — AND, first, the tree-wide
 * lease that admits this session to the tree at all, whichever
 * ladder tier is asking: tier 3 now claims a presence record of its own
 * there too, rather than only
 * checking one.
 *
 * Returns both leases this session now holds, or `{ lease: null, treeLease:
 * null }` in the one case that still claims nothing: this tree's OWN per-PR
 * lease already belongs to a live IDENTIFIED session (see the tier-3 branch
 * below) — the tree is represented there already, so a tier-3 claim here
 * would be a takeover it cannot justify.
 */
export async function claimLease(
  stateDir: string,
  pr: string,
  command: string,
): Promise<LeaseAdmission> {
  const session = resolveSession();
  const actor = await resolveActor();
  // Resolved HERE, not inside the locked section that records it: the memo in
  // `actor.ts` has already answered by now (`resolveActor` above went through
  // it), so this costs nothing — and it keeps the rule that no subprocess is
  // ever spawned while holding the state mutex every other command queues on.
  // Needed by BOTH branches below — the tier-3 presence record's `worktree`
  // field is the same one an identified session's lease carries.
  const worktree = await worktreeRoot();
  if (session.source === "none") {
    // Ladder tier 3 — no session identity, so no SESSION lease can be taken.
    // A lease that records a pid, and is written under no identity, excludes
    // nobody.
    //
    // It does not follow that nothing can be recorded. What this tree can
    // always prove is that it is THIS TREE, which is precisely the question the
    // PR-wide gate asks — so it writes a `holder: 'worktree'` record instead,
    // and the ordinary path below does it: the presence record IS a lease in
    // every respect except how liveness is tested, which is what lets it reuse
    // the admission protocol (state mutex on creation, PR-wide check under it,
    // `assertLeaseUnchanged` as the fence) rather than grow a parallel one that
    // would have to be argued from scratch.
    //
    // EXCEPT when this tree's OWN per-PR lease is already an identified
    // SESSION's, and it is alive. Then the tree is represented in the PR-wide
    // gate already — and, since every identified claim writes its tree lease
    // together with its per-PR one, the tree-wide record below already names
    // that same session too — so writing a worktree presence record over
    // either would only downgrade tiers 1-2 to tier 3's liveness (the same
    // hazard the fast path's own `seen.holder === holder` check exists to
    // avoid on renewal). This path claims neither and lets `drive-state.ts`
    // fence with `assertNoForeignDriveNow` + `acquireSessionlessTreeGuardNow`
    // instead, exactly as it always has.
    //
    // What this check is narrower than matters: `own` names THIS pr's per-PR
    // file alone, so it says nothing about an identified session driving a
    // DIFFERENT pr from this same tree. `claimSessionlessTreeLease` below
    // covers that — it reads the ONE tree-wide file, whichever pr the caller
    // names, and refuses on a live SESSION-held record there regardless.
    assertNoForeignDrive(stateDir, pr, actor);
    const own = readLease(leasePathFor(stateDir, pr, actor));
    if (own !== null && own.holder === "session" && leaseAlive(own)) {
      return { lease: null, treeLease: null };
    }
    // Claimed FIRST, mirroring the identified branch below
    // exactly: a conflict here (another live session anywhere in this tree,
    // or another sessionless resolver already on a DIFFERENT pr) refuses
    // before this command ever writes its own per-PR presence lease.
    const treeClaim = await claimSessionlessTreeLease(
      stateDir,
      actor,
      worktree,
      pr,
      command,
    );
    let lease: Lease;
    try {
      lease = await claimPrLease();
    } catch (err) {
      await rollbackFailedTreeClaim(
        treeLeasePathFor(stateDir, actor),
        treeClaim,
        pr,
        "presence record",
      );
      throw err;
    }
    return { lease, treeLease: treeClaim.lease };
  }
  const treePath = treeLeasePathFor(stateDir, actor);

  // Claimed FIRST. A conflict here (another session already
  // driving this tree, whichever PR) refuses before this command ever reads
  // or writes — or takes over — its own per-PR lease below.
  const treeClaim = await claimTreeLease(
    stateDir,
    actor,
    session,
    worktree,
    pr,
    command,
  );

  let lease: Lease;
  try {
    lease = await claimPrLease();
  } catch (err) {
    await rollbackFailedTreeClaim(treePath, treeClaim, pr, "lease");
    throw err;
  }
  return { lease, treeLease: treeClaim.lease };

  async function claimPrLease(): Promise<Lease> {
    const path = leasePathFor(stateDir, pr, actor);

    /** What this caller writes — see `Lease.holder` and ladder tier 3. */
    const holder: Lease["holder"] =
      session.source === "none" ? "worktree" : "session";

    // Fast path, deliberately LOCK-FREE: the lease is already ours and was
    // renewed moments ago, so there is nothing to decide and nothing to write.
    //
    // This is not an optimisation for its own sake. One session's mutating
    // commands are legitimately CONCURRENT — `claim-held` fans out one process
    // per key, and eight of them contending a mutex just to push the same
    // timestamp forward serialises a fan-out that conflicts over nothing (it
    // timed out the "only one of many concurrent claimants wins"
    // probe). The mutex exists to settle who OWNS the lease, and ownership is
    // not in question here.
    //
    // Reading unlocked cannot hand the lease to anyone: a foreign session may
    // only take one over after observing it as NOT alive, and this path returns
    // only when ours is alive by a wide margin (`renewAfterMs` is a fraction of
    // the staleness window). A torn or half-written read fails `readLease`'s
    // shape check and falls through to the locked path, which is also where a
    // lease that is missing, foreign, or due for renewal goes.
    const seen = readLease(path);
    if (
      seen !== null &&
      isMine(seen, session, actor) &&
      // A record of the OTHER kind is ours (same tree) but is not the one this
      // caller should be renewing, so it never short-circuits: an identified
      // session that found its own tree's tier-3 presence record must reach the
      // locked path and rewrite it as a SESSION lease. Skipping that would leave
      // the tree recorded pid-lessly for as long as the session kept renewing —
      // costing every other tree the fast dead-pid clear it is entitled to, and
      // silently downgrading tiers 1-2 to tier 3's liveness.
      seen.holder === holder &&
      Date.now() - Date.parse(seen.lastSeen) < renewAfterMs()
    ) {
      return seen;
    }

    // A TAKEOVER — overwriting another session's lease because its owner is dead
    // or has stopped renewing — is a REVOCATION, and every other revocation on
    // this PR coordinates with the state mutex: `clear-lease` takes it, `reset`
    // holds it across `clearAllLeases`. This path did not, which left the one
    // window the admission fence cannot see: the owner dies AFTER its child
    // passed `runFence()`, a replacement takes the lease over holding only the
    // lease mutex, and the old child then completes its mutation while the
    // replacement queues behind it — both writing under one actor, and for
    // `claim-held` both dispatching a non-idempotent answer.
    //
    // Taking the state mutex here closes it: a takeover can no longer land while
    // any command holds that mutex, which is exactly the interval between the
    // fence and the mutation it guards.
    //
    // ORDER IS state → lease, matching `clear-lease` and `reset` — the only two
    // other places both are held. Nothing anywhere takes them the other way
    // round, so this cannot deadlock against them. It is also strictly BEFORE
    // the command's own `store.locked`, never nested inside it: `claimLease` runs
    // at admission and releases both locks before returning.
    //
    // Only on the takeover path, decided from the unlocked read above. The
    // ordinary cases — no lease, our own lease due for renewal — do not revoke
    // anything and keep the cheap single-lock path, which matters because
    // `claim-held` fans out one process per key and the fast path above is what
    // keeps that from serialising on a mutex.
    //
    // ── What exactly needs the state mutex ──────────────────────────────────
    //
    // The rule is: **any write that MINTS A NEW GENERATION takes the state
    // mutex.** That is one invariant covering both cases, and it is the one the
    // fence actually depends on, because a new generation is precisely what
    // invalidates an outstanding admission.
    //
    //   - takeover  (`held` exists, is foreign, and is not alive) — the original
    //     case;
    //   - CREATION  (`held` is absent) — the later one. Scoping the mutex to
    //     takeovers alone left `reset` exposed to a tree it had never seen: a
    //     new actor's first claim writes a lease AFTER `clearAllLeases`
    //     enumerated, so the sweep reports no live foreign lease, `reset`
    //     deletes the shared state and claim files, and the freshly admitted
    //     command then runs against reset state seeing its own lease intact.
    //     Taking the mutex for creation makes enumeration and reset atomic with
    //     respect to new admissions, which is what that case needs.
    //
    // A RENEWAL preserves the generation, so it invalidates nothing and keeps the
    // cheap single-lock path — which is what matters for `claim-held`'s per-key
    // fan-out, since only the first of those can be a creation and the rest renew.
    //
    // ── And one more case, for the PR-WIDE gate ──────────────────
    //
    // A renewal of a lease that has gone QUIET past `leaseFreshMarginMs` takes
    // the state mutex too, and re-runs the PR-wide check under it. Both halves
    // are needed. A lease that quiet is approaching the point where a foreign
    // tree may legitimately observe it as dead and take the PR — so continuing to
    // renew it without looking is precisely how this session would resume beside
    // a successor that was correctly admitted while it was idle. The state mutex
    // is what makes that look authoritative rather than advisory.
    //
    // Inside the margin the check is SKIPPED, and that skip is an argument, not
    // an optimisation — see `leaseFreshMarginMs`. It is also what keeps the
    // `claim-held` fan-out off the state mutex: those renewals are seconds old.
    //
    // `isRecycledPid(seen, session)` is checked ALONGSIDE `!leaseAlive(seen)`,
    // not folded into it: `leaseAlive`'s pid half is meaningless evidence for
    // this specific `seen` once `seen.pid === session.pid`, because that call
    // is then asking whether `session` itself is running — trivially yes,
    // regardless of how long ago the dead predecessor who actually wrote `seen`
    // stopped renewing it. Without this, a pid the OS reused inside the
    // staleness window reads as a live FOREIGN lease (below) rather than a
    // takeover, which is exactly the collision: `isMine` correctly
    // says "not mine", but `leaseAlive` alone would keep saying "and it's still
    // out there" for as long as `session` — i.e. itself — keeps running.
    const mintsNewGeneration =
      seen === null ||
      (!isMine(seen, session, actor) &&
        (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
    const quietPastMargin =
      seen !== null &&
      Date.now() - Date.parse(seen.lastSeen) > leaseFreshMarginMs();
    return await withLeaseLock(mintsNewGeneration || quietPastMargin);

    async function withLeaseLock(holdState: boolean): Promise<Lease> {
      // Acquired BEFORE the state mutex, not nested inside it
      //: the first cut of this fix
      // nested the acquisition inside `underLocks`, below the state mutex
      // and `leaseLock` — so a NEW claimant waiting out an in-flight push
      // held the state mutex for the ENTIRE wait (up to
      // `LOCK_ACQUIRE_MAX_SEC`), blocking every OTHER `drive-state.ts`
      // mutation on this PR from ANY worktree — including a `claim-held`
      // fan-out's OTHER processes, and any already-admitted worktree's own
      // ordinary progress — behind a wait that has nothing to do with
      // them. Acquiring it first keeps the state mutex's own hold to what
      // it has always been: the brief read-decide-write section below, not
      // this wait. `guarded-push.ts` and `answer-summary-finding.ts` already
      // acquire this lock before anything else they hold, for the identical
      // reason; this makes every acquirer of `prRemoteMutationLock`
      // consistent about taking it FIRST, which is also what rules out a
      // new deadlock — see the lock-ordering note beside `treeLeaseLock`'s
      // own definition.
      //
      // Bounded the same way every OTHER acquisition in this module is —
      // `acquire()`'s own `limit` is `Math.min(LOCK_ACQUIRE_MAX_SEC,
      // $DRIVE_PR_LOCK_TIMEOUT ?? 30, …)`, so `LOCK_ACQUIRE_MAX_SEC` is
      // ALREADY the ceiling on every call regardless of whether it is
      // passed explicitly here — passing it changes nothing (it can only
      // ever LOWER `acquire()`'s own `maxWaitSec` term, never raise the
      // other two — see that function's own comment). It is passed anyway,
      // to say what this call intends rather than lean on that being true
      // of the current implementation.
      //
      // What genuinely differs from a bare `acquire()` is the CATCH below.
      // Contention on THIS lock, unlike the ordinary case `acquire()`'s own
      // generic timeout message is written for, can legitimately still be
      // live past whatever bound applied — a `git push` can run for the
      // whole of `$DRIVE_PR_PUSH_TIMEOUT` (an hour, by default) — so a
      // timeout here is not necessarily "wedged" the way it is everywhere
      // else `acquire()` throws. Reported as the SAME exit 11 every other
      // live-foreign-driver refusal in this module uses, with that
      // distinction spelled out, rather than `acquire()`'s own generic
      // exit 1 — which would read as a stuck lock rather than as the
      // outcome this actually is: another worktree is still actively
      // finishing an irreversible mutation. The residual this does NOT
      // close — a genuinely hour-long push can still outlast whatever this
      // call ends up bounded to, and a claim landing in that window is
      // refused rather than admitted after truly waiting the mutation
      // out — is the same one every other lock in this module accepts and
      // states rather than hides (see `LOCK_ACQUIRE_MAX_SEC`'s own doc).
      const remoteLock = holdState ? prRemoteMutationLock(stateDir, pr) : null;
      await acquireClaimRemoteLock(remoteLock, pr);
      // Heartbeat `remoteLock`'s mtime for as long as it is held, starting
      // the instant it is acquired — including through `stateLock.acquire()`
      // and the whole of `underLocks()` below: if `$DRIVE_PR_LOCK_STALE_MIN`
      // is shorter than the time those two genuinely take — an
      // operator-shortened staleness window, or ordinary contention on
      // `stateLock`/`leaseLock` from a `claim-held` fan-out — a contending
      // `acquire()` elsewhere could otherwise treat this still-live hold as
      // abandoned and break it before the admission write ever runs,
      // reopening the exact overlap this lock exists to prevent. The two
      // remote-mutation callers (`guarded-push.ts`,
      // `answer-summary-finding.ts`) already heartbeat for the identical
      // reason across their own, longer-running mutation.
      const remoteLockHeartbeat =
        remoteLock === null
          ? null
          : setInterval(() => remoteLock.touch(), lockHeartbeatMs());
      const stateLock = holdState
        ? createLock(
            join(stateDir, `drive-pr-${pr}.json`),
            "drive-state.ts",
            pr,
          )
        : null;
      // Wrapped: `stateLock.acquire()` can itself throw (contention past its
      // own bound, or a broken lock directory), and it sits BEFORE the
      // `try/finally` below that would otherwise clean up. Left unguarded,
      // a throw here left `remoteLockHeartbeat` running and `remoteLock`
      // held forever — `runMain` only ever sets `process.exitCode`, never
      // calls `process.exit()`, so a live `setInterval` keeps the event
      // loop (and therefore the whole CLI process) alive indefinitely,
      // continuing to heartbeat a lock that guards every later claim,
      // push, or POST for this PR until something external kills the
      // process.
      if (stateLock) {
        try {
          await stateLock.acquire();
        } catch (e) {
          if (remoteLockHeartbeat !== null) clearInterval(remoteLockHeartbeat);
          stateLock.dispose();
          releaseClaimRemoteLock(remoteLock);
          throw e;
        }
      }
      try {
        return await underLocks(holdState);
      } finally {
        if (remoteLockHeartbeat !== null) clearInterval(remoteLockHeartbeat);
        if (stateLock) {
          stateLock.release();
          stateLock.dispose();
        }
        releaseClaimRemoteLock(remoteLock);
      }
    }

    async function underLocks(holdState: boolean): Promise<Lease> {
      const lock = leaseLock(path, pr);
      await lock.acquire();
      try {
        const held = readLease(path);
        const mine = held !== null && isMine(held, session, actor);
        // The unlocked peek can be wrong in the direction that matters: a lease
        // that looked alive (or looked ours) may have died between that read and
        // this one, which would take it over WITHOUT the state mutex — the same
        // hole, merely narrower. Restart under both locks instead. Bounded at one
        // retry: the second pass already holds the state mutex, so this branch
        // cannot be reached again. Releasing before re-acquiring keeps the
        // state → lease order intact; upgrading in place would invert it.
        //
        // The margin clause is the PR-wide gate's share of the same hazard: the
        // unlocked peek may have read a `lastSeen` that was inside the freshness
        // margin and is outside it by now (the peek is not instantaneous — a lock
        // acquisition sits between them). Re-deciding on the LOCKED read is what
        // keeps "skipped the check because we were comfortably fresh" true of the
        // moment the lease is actually written, rather than of a stale snapshot.
        if (
          !holdState &&
          (held === null ||
            (!mine &&
              (!leaseAlive(held) || isRecycledPid(held, session, actor))) ||
            Date.now() - Date.parse(held.lastSeen) > leaseFreshMarginMs())
        ) {
          lock.release();
          lock.dispose();
          return await withLeaseLock(true);
        }
        if (held !== null && !mine) reportPrTakeover(held, session, actor, pr);

        // The PR-WIDE gate, run only on the path that holds the state
        // mutex — which is every path that could newly grant this tree the PR, by
        // the construction above. AFTER the per-tree refusal, so a session that
        // has both problems is told about the one in its own tree first: it is
        // the nearer fact and the one it can act on where it stands.
        //
        // Before the write, never after. A refusal that had already installed
        // this tree's lease would leave a live foreign lease of its own behind —
        // visible to `lease --all`, blocking `reset`, and, worse, one this
        // session's NEXT command would fast-path off without ever re-reaching
        // this check. Refusing first means a refused tree holds nothing.
        if (holdState) assertNoForeignDrive(stateDir, pr, actor);
        // The PR-wide remote-mutation lock is already held by
        // this point — `withLeaseLock`, above, acquires it BEFORE this
        // function's own state mutex and holds it through this entire
        // call, so the write below is protected without anything further
        // needed here. See that function's own comment for why it moved
        // there and what it closes.
        const lease = leaseForClaim(
          holder,
          session,
          actor,
          worktree,
          command,
          held,
          mine,
        );
        atomicWrite(path, `${JSON.stringify(lease, null, 2)}\n`);
        return lease;
      } finally {
        lock.release();
        lock.dispose();
      }
    }
  }
}

/**
 * The admission fence: is the lease this command was admitted on STILL the one
 * on disk, now that it finally holds the state mutex?
 *
 * Admission and mutation are not the same instant. `claimLease` returns, and
 * the command then queues for the state lock — for up to `LOCK_ACQUIRE_MAX_SEC`.
 * Everything that can revoke its admission happens in that gap, in another
 * process, silently: `reset`'s sweep, an operator's `clear-lease` (documented
 * for taking over a lease whose holder they believe is gone), a takeover after
 * the owning pid exits, or the staleness expiry. Preserving live leases in
 * `clearAllLeases` covers the first of those and nothing else, and no
 * wall-clock rule can cover the dead-pid path at all — `leaseAlive` goes false
 * the instant the agent process exits, while the child it already spawned is
 * still queued and will still mutate.
 *
 * So the check is here, at the only point that sees the lease as it stands when
 * the mutation is about to run. `generation` is the token: a random nonce,
 * preserved across one session's renewals and reminted by every takeover, so
 * comparing (pid, host, generation) distinguishes "my lease, renewed" from
 * "someone else's lease now". A missing file is a takeover too — that is the
 * swept case.
 *
 * NOT `startedAt`, which this first used: ISO text resolves to the millisecond,
 * so a `clear-lease` and a same-session reclaim inside one millisecond produce
 * an identical tuple and the fence would wave through a lease that had actually
 * been revoked and recreated.
 *
 * One window this deliberately does NOT close: the check and the write are not
 * themselves atomic against revocation, because `clearLease` takes only the
 * lease mutex. `clear-lease` closes that by taking the state mutex too — see
 * its own comment — which is the coordination that makes this check hold
 * through the mutation rather than merely at its start.
 *
 * Fails closed, with exit 11 like every other lease refusal: the mutation has
 * not run, so refusing costs a re-run, while proceeding is the same-actor
 * double-write this module exists to prevent.
 */
export function assertLeaseUnchanged(
  stateDir: string,
  pr: string,
  admitted: Lease,
): void {
  const held = readLease(leasePathFor(stateDir, pr, admitted.actor));
  if (
    held !== null &&
    held.pid === admitted.pid &&
    held.host === admitted.host &&
    held.generation === admitted.generation
  ) {
    return;
  }
  fail(
    11,
    `drive-state.ts: PR #${pr}'s drive lease was taken over while this command waited for the state lock.`,
    held === null
      ? "The lease this command was admitted on is gone — swept by `reset`, or dropped by `clear-lease`."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers under one actor overwrite each other’s holds and",
    "double-reply every thread. Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this PR.",
  );
}

async function rollbackFailedTreeClaim(
  path: string,
  treeClaim: Awaited<ReturnType<typeof claimTreeLease>>,
  pr: string,
  description: "presence record" | "lease",
): Promise<void> {
  if (treeClaim.wroteRaw === null) return;
  try {
    await rollbackTreeLease(path, treeClaim.wroteRaw, treeClaim.beforeRaw);
  } catch (rollbackErr) {
    console.error(
      `drive-state.ts: could not roll back this tree's TREE ${description} after a failed admission (${(rollbackErr as Error)?.message ?? rollbackErr}).`,
    );
    console.error(
      `If it now wedges another session, clear it deliberately:  drive-state.ts clear-lease ${pr}`,
    );
  }
}

function reportPrTakeover(
  held: Lease,
  session: Session,
  actor: string,
  pr: string,
): void {
  // `isRecycledPid` overrides `leaseAlive` here for the same reason it
  // overrides it in `mintsNewGeneration` above: once `held.pid ===
  // session.pid`, `leaseAlive`'s pid check is asking whether THIS
  // process is running, which is tautologically true and says nothing
  // about the dead predecessor `isMine` has already proven wrote `held`.
  if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
    fail(
      11,
      `drive-state.ts: PR #${pr} is already being driven from this working tree by another session (${leaseHolderLabel(held)}).`,
      `It took the lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two drivers in ONE tree share one actor id, so their holds overwrite each",
      "other and every thread ends up with two outcome replies — which is not",
      "repairable once posted. Refusing to be the second.",
      "",
      // Host-qualified on purpose: a pid is only meaningful on the host it
      // lives on, so an unqualified check run here would answer about an
      // unrelated local process and could read as "gone" for a lease that
      // is genuinely live elsewhere — the one mistake this refusal must
      // not invite. `pidAlive` already refuses to judge a foreign host for
      // the same reason. `pidCheckCommand` owns both that qualification
      // and the platform spelling (`ps -p` vs PowerShell's `Get-Process`).
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      `Otherwise the lease clears itself once that session has left drive state`,
      `untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    isRecycledPid(held, session, actor)
      ? `drive-state.ts: took over a drive lease on PR #${pr} whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}).`
      : `drive-state.ts: took over an abandoned drive lease on PR #${pr} (${leaseHolderLabel(held)} — gone or idle since ${held.lastSeen}).`,
  );
}

async function acquireClaimRemoteLock(
  remoteLock: PathLock | null,
  pr: string,
): Promise<void> {
  if (remoteLock !== null) {
    try {
      await remoteLock.acquire(LOCK_ACQUIRE_MAX_SEC);
    } catch (e) {
      // Never acquired, so nothing for `release()` to give back — but
      // A handle owns its cleanup registration before acquisition, so a
      // failed attempt still needs disposal.
      remoteLock.dispose();
      // `LockAcquireTimeoutError` specifically, NOT the broader
      // `ExitError` every `acquire()` failure is: `acquire()` also
      // throws a plain `ExitError(1)` when it wins the `mkdir` but then
      // fails to create its ownership marker (`EACCES`, `ENOSPC`, a
      // read-only filesystem) — an infrastructure failure with no rival
      // holder involved at all. Relabeling THAT as "another worktree has
      // a mutation in flight" would tell a human or an orchestrator to
      // wait it out instead of surfacing the broken state directory.
      // Only the deadline-exceeded case this lock genuinely waited out
      // gets converted to the live-contention exit 11 below; anything
      // else keeps its own exit code and message untouched.
      if (!(e instanceof LockAcquireTimeoutError)) throw e;
      fail(
        11,
        `drive-state.ts: PR #${pr} has an irreversible remote mutation (a push or a posted reply) in flight from another worktree, and it has not cleared yet.`,
        "",
        "Refusing this claim rather than admit alongside it — the identical",
        "cross-shipping hazard this PR-wide lock exists to close.",
        "This is not necessarily wedged: a push can legitimately run for the",
        "whole of $DRIVE_PR_PUSH_TIMEOUT (an hour, by default, pre-push hooks",
        "included), longer than this wait was bounded to. Retry once it",
        "completes.",
      );
    }
  }
}

function releaseClaimRemoteLock(lock: PathLock | null): void {
  if (lock !== null) {
    lock.release();
    lock.dispose();
  }
}

/** Clear or release admitted lease generations while preserving live foreign ownership. */
import {
  type Lease,
  type TreeLease,
  leasePathFor,
  treeLeasePathFor,
  canonicalLeasePr,
  resolveSession,
} from "./lease-model.ts";

import { resolveActor } from "./actor.ts";

import { leaseLock, treeLeaseLock, leaseFilesFor } from "./lease-files.ts";

import {
  readLease,
  readTreeLease,
  leaseAlive,
  isRecycledPid,
} from "./lease-records.ts";

import { rmSync } from "node:fs";

import { LOCK_ACQUIRE_MAX_SEC, type PathLock } from "./lock.ts";

/**
 * Drop the lease for (this working tree, this PR) — and, unconditionally,
 * this tree's TREE-WIDE lease, so the remedy every tree-lease
 * refusal names (`drive-state.ts clear-lease <pr>`) actually works: a refusal
 * whose suggested fix leaves the tree still locked is not a remedy, and a
 * human running this from inside the tree is already overriding a claim —
 * the identical override plain `clear-lease` has always applied to a LIVE
 * per-PR lease (see this function's own history: it has never asked whether
 * the lease it drops is stale before dropping it).
 *
 * The one case this trades away: a SINGLE session juggling two PRs from one
 * tree that `clear-lease`s one deliberately while the other is genuinely
 * still in flight also releases the tree lease — its own very next mutating
 * command simply reclaims it, since `isMine` still matches, so nothing here
 * refuses that session; a DIFFERENT session racing into the gap is the same
 * class of window every takeover in this module already accepts, bounded the
 * same way.
 *
 * Returns what was there for BOTH leases — the per-PR one and the tree one
 * — so a caller can report the tree lease it silently dropped too. Returning
 * only the per-PR record (the first version's shape) let an operator follow a
 * cross-PR refusal's own `clear-lease <requested-pr>` suggestion — where
 * there is normally no PER-PR lease for that pr at all — and see "nothing to
 * clear" while the live TREE lease they were actually overriding vanished
 * unreported.
 */
export async function clearLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  const path = leasePathFor(stateDir, pr, actor);
  const lock = leaseLock(path, pr);
  let held: Lease | null;
  await lock.acquire();
  try {
    held = readLease(path);
    rmSync(path, { force: true });
  } finally {
    lock.release();
    lock.dispose();
  }
  const treePath = treeLeasePathFor(stateDir, actor);
  const treeLock = treeLeaseLock(treePath);
  let treeHeld: TreeLease | null;
  await treeLock.acquire();
  try {
    treeHeld = readTreeLease(treePath);
    rmSync(treePath, { force: true });
  } finally {
    treeLock.release();
    treeLock.dispose();
  }
  return { lease: held, treeLease: treeHeld };
}

/**
 * Release the TIER-3 PRESENCE RECORDS this working tree holds for `pr`, because
 * the sessionless resolver that took them has finished.
 *
 * ── The asymmetry it closes ─────────────────────────────────────────────────
 *
 * A `holder: 'session'` lease is released for free: `leaseAlive` tests its pid,
 * so the record stops excluding anybody the instant that process dies, whether
 * the session ended cleanly or crashed. A `holder: 'worktree'` record has no pid
 * to test (the ladder's tier-3 entry in this module's header says why one must
 * not be invented), so `lastSeen` freshness is its ONLY liveness signal, and
 * it does not mark a CLEAN COMPLETION. Without a release, a sessionless
 * resolver that finished its work perfectly leaves a record that goes on
 * refusing every other working tree with exit 13 for up to
 * `DRIVE_PR_LEASE_STALE_MIN` (default 360m).
 *
 * That staleness wait is accepted knowingly — two sessionless resolvers both
 * driving and both posting duplicate outcome replies is strictly worse and
 * unrepairable once posted — but it is a cost of having no pid to test, not a
 * cost of having no *completion signal*. `converge.ts` (in
 * `/resolve-review-comments`) is exactly that signal: it is the loop that spawns
 * every sessionless pass and the one process that knows, definitively, when it
 * will spawn no further one. It reaches this through the standalone
 * `release-sessionless-lease.ts` CLI — a SPAWN of a sibling skill's executable,
 * never an import of this module, for the reasons `../references/post-fence.md`
 * records for `assert-post-allowed.ts`.
 *
 * ── Why not `clearLease` ────────────────────────────────────────────────────
 *
 * `clearLease` above is a HUMAN OVERRIDE and is unconditional by design: it
 * drops the per-PR lease and the tree lease whatever their holder, and whatever
 * pr the tree lease names. Both properties are wrong for an automated,
 * speculative release:
 *
 *   - IT WOULD DROP A `holder: 'session'` LEASE. A session lease already
 *     self-releases when its pid dies, so this mechanism buys nothing there and
 *     would spend the whole of `isMine`'s pid-recycling / `sessionStarted`
 *     reasoning (this module's header, residual 3) on a case it does not serve.
 *     So the discriminant is the RECORD's own `holder` field — never the
 *     releasing process's identity, which may legitimately differ from the one
 *     that took the record (a `converge.ts` running under Claude Code spawns
 *     passes that inherit `$CLAUDE_PID` and therefore claim tier-2 SESSION
 *     leases; this then correctly releases nothing).
 *   - IT WOULD DROP A TREE LEASE THAT HAS MOVED ON. `treeLeasePathFor` is ONE
 *     file per working tree, and its `pr` field names whichever PR that tree is
 *     currently driving. A tree that finished PR A and has since started PR B
 *     under a second sessionless resolver holds a tree record naming B; dropping
 *     it at A's completion would strip B's live protection — a NEW hazard, not a
 *     leftover one. So the tree half additionally requires the record's `pr` to
 *     canonically equal the PR being released (`canonicalLeasePr`, the same
 *     spelling the writer used, so reader and writer agree by construction).
 *
 * ── Fail direction ─────────────────────────────────────────────────────────
 *
 * Deliberately the OPPOSITE of every fence in this module, and that inversion is
 * the whole reason a "best effort" posture is legitimate here rather than a
 * violation of the fail-closed rule for gates. A fence that cannot read its
 * input must refuse, because failing the other way PERMITS an irreversible act.
 * This one authorises nothing: not releasing simply leaves the record to expire
 * by staleness, which is precisely the behaviour that existed before an earlier
 * change. So an unreadable record is LEFT ALONE (`readLease` / `readTreeLease`
 * answer `null` for absent and for unparseable alike, and only a
 * positively-read `holder: 'worktree'` is removed), and a caller may invoke this
 * speculatively, repeatedly, and against a PR it never drove.
 *
 * ── Locking ────────────────────────────────────────────────────────────────
 *
 * Read-under-lock and remove-under-lock, on the same two mutexes and in the same
 * (non-nested) order as `clearLease`, so a concurrent `claimLease` renewal
 * cannot interleave between the holder test and the removal and leave a record
 * this function already decided not to keep. Callers take the PR's STATE MUTEX
 * around it exactly as `drive-state.ts`'s `clear-lease` does — see that command's
 * own comment: the admission fence (`assertLeaseUnchanged`) runs inside a locked
 * section and is followed by that section's write, and a removal landing between
 * those two would make an already-admitted command refuse a mutation that was
 * never in conflict. Holding the state mutex means a release can only land
 * BETWEEN locked sections.
 *
 * ── The residual, stated ───────────────────────────────────────────────────
 *
 * TWO SESSIONLESS RESOLVERS IN ONE TREE, ON THE SAME PR, are indistinguishable
 * to every identity this runtime exposes — the identity floor tier 3 carries —
 * so one finishing releases a record the other is also relying on. It is
 * bounded on both sides and does not reopen the hole: that record never
 * excluded a caller in its OWN tree in the first place (every invocation there
 * resolves the same actor), and the sibling's very next mutating
 * `drive-state.ts` command re-claims it via `claimSessionlessTreeLease` /
 * `claimLease`. The exposure is therefore another TREE being admitted during
 * the gap between this release and that next mutation — narrower than the
 * standing case of two sessionless resolvers in one tree racing each other's
 * replies, which nothing here makes better or worse.
 *
 * Returns what it removed — both halves, independently, for the same reason
 * `clearLease` does: a caller that reported only the per-PR half would make the
 * tree record's removal invisible on the call where there is often no per-PR
 * record at all.
 */
export async function releaseSessionlessLease(
  stateDir: string,
  pr: string,
): Promise<{ lease: Lease | null; treeLease: TreeLease | null }> {
  const actor = await resolveActor();
  const canonicalPr = canonicalLeasePr(pr);

  const path = leasePathFor(stateDir, pr, actor);
  const lock = leaseLock(path, pr);
  let released: Lease | null = null;
  await lock.acquire();
  try {
    const held = readLease(path);
    // ONLY a positively-read tree-held record. `null` covers absent AND
    // unreadable, and both mean "nothing this function may act on".
    if (held !== null && held.holder === "worktree") {
      rmSync(path, { force: true });
      released = held;
    }
  } finally {
    lock.release();
    lock.dispose();
  }

  const treePath = treeLeasePathFor(stateDir, actor);
  const treeLock = treeLeaseLock(treePath);
  let treeReleased: TreeLease | null = null;
  await treeLock.acquire();
  try {
    const treeHeld = readTreeLease(treePath);
    // The `pr` test is what keeps this from stripping a DIFFERENT, still-live
    // drive's protection — see this function's doc comment. Compared through
    // `canonicalLeasePr` on both sides, matching every other reader/writer pair
    // in this module (a leading-zero mismatch once slipped through here).
    if (
      treeHeld !== null &&
      treeHeld.holder === "worktree" &&
      canonicalLeasePr(treeHeld.pr) === canonicalPr
    ) {
      rmSync(treePath, { force: true });
      treeReleased = treeHeld;
    }
  } finally {
    treeLock.release();
    treeLock.dispose();
  }

  return { lease: released, treeLease: treeReleased };
}

/**
 * Sweep this PR's leases from EVERY tree — `reset`'s share of "forget
 * everything for this PR", which the per-tree `clearLease` cannot do because
 * the tree running the reset may not be the one that got wedged.
 *
 * Every lease goes EXCEPT another tree's that is still live, which is preserved
 * and returned so the caller can say so. The distinction is the whole point: a
 * live lease is not a wedged one. Wedged means the session behind it is gone or
 * has stopped driving, and `leaseAlive` is exactly that test — so `reset` still
 * sweeps every lease a human could be reaching for it to clear, and preserves
 * only the ones whose driver is demonstrably still working.
 *
 * Deleting a live foreign lease is not merely rude, it re-opens the exact hole
 * this module exists to close, and does so in a tree the operator is not
 * standing in and cannot see. A command in that tree can already be ADMITTED —
 * past `claimLease`, waiting on the state mutex `reset` itself holds — and it
 * will not retake a lease when it wakes, because it took one on the way in. So
 * "the driver's next mutating command simply takes a fresh one" does not cover
 * the command already in flight: between `reset` deleting the file and that
 * driver's NEXT command, a second session in that tree claims the absent lease
 * and runs alongside the admitted one, under one actor. Preserving
 * the live lease closes that without any fencing protocol, because the file
 * that would have to be missing never goes missing.
 *
 * Each file is read and removed under its OWN lease lock — the same one
 * `claimLease` writes under — so a renewal cannot land between the liveness
 * read and the `rm` and be deleted as though it were stale. `claimLease`
 * releases that lock before its caller ever reaches for the state mutex, so a
 * `reset` holding the state mutex and reaching for a lease lock cannot deadlock
 * against it.
 *
 * The CALLER'S OWN live lease is preserved too, and for the identical reason
 * — the caller's tree is a tree like any other, and `reset` is not the only
 * thing running in it. A command from the SAME session can be admitted and
 * waiting on the state mutex `reset` holds; dropping that session's lease lets
 * a second session in that tree claim the absent one and mutate beside the
 * admitted command, under one actor. Only the REPORT distinguishes the two:
 * the caller's own preserved lease is not news to the caller, another tree's
 * is the only way they learn there was anything to decide.
 *
 * "Own" is matched by `ownLease` — the lease `claimLease` actually returned —
 * and by nothing else. This used to take the caller's ACTOR as well, which was
 * dead weight in the signature and misleading beside a comment naming it:
 * actor equality is a claim about the TREE, and a measured case showed
 * exactly why that is not ownership (see the `isOwn` comment below).
 *
 * `removed` names what phase 2 actually deleted — empty whenever nothing was
 * (a live foreign lease short-circuits before phase 2 ever runs; an
 * uncontended sweep with no stale leases at all runs phase 2 but deletes
 * nothing). `reset`'s OWN later refusals (a live claim, checked after this
 * call returns) are not reflected here — this function has no way to know
 * about them — so a caller that refuses on its own account after a
 * successful, non-empty `removed` must not repeat this function's "nothing
 * deleted" framing verbatim: leases were deleted, even though the state file,
 * claim files, and handoff were not.
 *
 * `preserveLive: false` turns every one of those preservations off, and is the
 * ONE deliberate override: `clear-lease --all`, the way a human takes a PR back
 * from a working tree they cannot stand in. Every caveat above still
 * describes exactly what they are choosing to do — which is why it is an
 * explicit flag on a command a human types, never a fallback anything reaches
 * for on its own. It is the cross-tree twin of plain `clear-lease`, which has
 * always been able to drop a LIVE lease in the caller's own tree for the same
 * reason: a refusal whose only remedy is another refusal is not a remedy.
 */
export async function clearAllLeases(
  stateDir: string,
  pr: string,
  ownLease: Lease | null,
  preserveLive = true,
): Promise<{ preservedForeign: Lease[]; removed: string[] }> {
  // TWO PHASES, and the split is the whole point: acquire every lease lock
  // first, delete only once they are all held.
  //
  // Deleting inside the acquire loop meant a lock that could not be taken threw
  // with EARLIER lease files already gone — a prefix swept, and `reset`'s own
  // diagnostic promising the caller that a non-zero exit means "no change"
  //. Ordering the sweep before the state
  // deletions fixed the state half of that claim and left the lease half false.
  //
  // Staged this way the claim is true of both: the only fallible step is
  // acquisition, and nothing has been removed while it is still running. A
  // failure releases whatever was taken and rethrows, having deleted nothing.
  // `performance.now()`, not `Date.now()`: this measures an ELAPSED budget, and
  // wall-clock is not monotonic. An NTP step or an administrator adjustment
  // moving the clock BACKWARD inflates the remaining allowance handed to each
  // later `acquire()`, so a contended sweep can hold the shared state mutex far
  // past the single 300s budget this is supposed to cap. `lock.ts`'s own
  // `acquireDeadline` switched to the monotonic clock for exactly this reason;
  // the aggregate deadline layered on top of it has to use the same one or it
  // silently undoes that.
  const sweepDeadline = performance.now() + LOCK_ACQUIRE_MAX_SEC * 1000;
  const taken: PathLock[] = [];
  const preservedForeign: Lease[] = [];
  // Declared outside the `try` so the final return (after `finally` releases
  // every lock) can still report it — phase 2 below populates it in place.
  const removed: string[] = [];
  try {
    // Phase 1 — acquire. ONE deadline shared across the whole sweep, because
    // `reset` holds the PR's state mutex throughout: each `acquire()` may wait
    // up to `LOCK_ACQUIRE_MAX_SEC`, so N contended locks would otherwise block
    // every other state mutation for N × 300s, growing with the number of trees
    // that have ever driven the PR. The budget only
    // ever LOWERS a per-lock bound; it never asks for longer than the clamp.
    const doomed: string[] = [];
    // Only resolved when a live lease could actually be PRESERVED by it:
    // `clear-lease --all` runs with `preserveLive` off and must not pay for
    // — or risk failing on — a session resolution its own decision never
    // consults.
    const session = preserveLive ? resolveSession() : null;
    const actor = preserveLive ? await resolveActor() : "";
    for (const f of leaseFilesFor(stateDir, pr)) {
      const lock = leaseLock(f, pr);
      // Registered for cleanup BEFORE the await, not after it. `createLock`
      // installs its exit/SIGINT/SIGTERM handlers at construction, so a lock
      // whose `acquire` rejects had already added three listeners while never
      // reaching `taken` — and the `finally` below then skipped its `dispose`.
      // Repeated failed resets leaked exactly the listeners that disposal was
      // added to stop. Releasing a lock
      // that was never acquired is a no-op, so the early push is safe.
      taken.push(lock);
      await lock.acquire(
        Math.max(0, (sweepDeadline - performance.now()) / 1000),
      );
      const held = readLease(f);
      // `isRecycledPid` alongside `leaseAlive`, not folded into it — same
      // reason as `claimLease` and `assertNoForeignDrive`: once `held.pid` is
      // THIS session's own pid, `leaseAlive`'s pid half proves only that the
      // caller is running, never that `held`'s actual writer is.
      // `isOwn` below is unaffected — it also compares `generation`, which
      // recycling cannot forge. Unlike `assertRemoteMutationAllowed` (whose
      // own comment explains why it deliberately stays unaware of this), this
      // function guards a REVOCATION decision an operator explicitly asked
      // for (`reset`), where treating a recycled-pid lease as the wedge it
      // actually is — not a live rival to preserve — is the whole point.
      if (
        preserveLive &&
        held !== null &&
        leaseAlive(held) &&
        !(session !== null && isRecycledPid(held, session, actor))
      ) {
        // A live lease is silent ONLY if it is the caller's own — matched by
        // the lease `claimLease` actually returned, not by the actor.
        //
        // Actor equality is a claim about the TREE, and equating it with
        // ownership breaks in exactly the case the lease exists for: run
        // `reset` from this checkout with no session identity at all (tier 3 —
        // `$DRIVE_PR_SESSION` and `$CLAUDE_PID` both unset) and `claimLease`
        // admits nothing, yet a real driver's live lease in this same tree
        // still carries this very tree's actor. Treating that as "mine, not news"
        // reported success and deleted the shared state and claim files out
        // from under a live driver, whose generation is unchanged so its fence
        // still passes — and whose in-flight finding dispatch can then be
        // duplicated.
        //
        // With `ownLease` null, every live lease blocks, which is the right
        // answer for a caller that holds none.
        const isOwn =
          ownLease !== null &&
          held.actor === ownLease.actor &&
          held.pid === ownLease.pid &&
          held.host === ownLease.host &&
          held.generation === ownLease.generation;
        if (!isOwn) preservedForeign.push(held);
        continue;
      }
      doomed.push(f);
    }
    // A live FOREIGN lease stops the sweep here, having deleted NOTHING.
    //
    // `reset` refuses on this result and tells the operator nothing was
    // deleted. That was false while phase 2 ran first: a MIXED set — some
    // stale leases plus one live foreign one — swept the stale ones and then
    // returned the refusal anyway.
    // Returning before phase 2 makes the caller's diagnostic true, and makes
    // this function's own contract simply "sweeps everything, or nothing".
    if (preservedForeign.length > 0) return { preservedForeign, removed: [] };
    // Phase 2 — delete. `force: true` only makes a MISSING target harmless; it
    // does not make deletion infallible (EACCES, EPERM, EROFS, an I/O error).
    // An earlier version of this comment claimed it did, and `reset`'s contract
    // was written on that claim.
    //
    // So the two failure classes are separated rather than conflated. A phase-1
    // failure really is "nothing changed" — that is what the staging buys. A
    // phase-2 failure is a genuinely partial sweep, and it is reported AS one:
    // every file is attempted, and the error then NAMES what was removed and
    // what remains, so the operator is not left to guess which half happened.
    // Recoverable rather than transactional on purpose: a rename-based journal
    // would add a crash-recovery surface of its own to guard against a
    // filesystem that is already refusing writes.
    removeLeaseFiles(pr, doomed, removed);
  } finally {
    for (const lock of taken) {
      lock.release();
      // One lock per lease FILE, so this is the one place locks are created in
      // bulk. Each registers exit/SIGINT/SIGTERM handlers that nothing else
      // removes, so without disposal they pile up on the process for the rest
      // of its life, one set per tree. Disposal is after `release`, never
      // before: the handlers exist to release an abnormally terminated hold.
      lock.dispose();
    }
  }
  return { preservedForeign, removed };
}

/** Delete only after every candidate lock is held, reporting partial failures. */
function removeLeaseFiles(
  pr: string,
  doomed: string[],
  removed: string[],
): void {
  const failed: { file: string; err: unknown }[] = [];
  for (const f of doomed) {
    try {
      rmSync(f, { force: true });
      removed.push(f);
    } catch (err) {
      failed.push({ file: f, err });
    }
  }
  if (failed.length > 0) {
    const detail = failed
      .map((x) => `  ${x.file}: ${(x.err as Error)?.message ?? x.err}`)
      .join("\n");
    throw new Error(
      `clearAllLeases: PARTIAL sweep of PR #${pr} — ${removed.length} lease(s) removed, ${failed.length} could not be.\n` +
        `Removed:\n${removed.map((f) => `  ${f}`).join("\n") || "  (none)"}\n` +
        `Left in place:\n${detail}\n` +
        "The lease set has CHANGED. Re-run once the cause is fixed; the sweep is idempotent.",
    );
  }
}

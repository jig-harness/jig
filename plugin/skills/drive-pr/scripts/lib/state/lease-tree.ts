/** Admit identified or sessionless work within one tree, including rollback and generation checks. */
import {
  leaseForClaim,
  treeLeaseUnreadableAndFresh,
  readTreeLease,
  leaseAlive,
  ageLabel,
  leaseLivenessHint,
  isMine,
  isRecycledPid,
  parseTreeLease,
  leaseHolderLabel,
} from "./lease-records.ts";

import { fail } from "../cli.ts";

import {
  leaseStaleMin,
  treeLeasePathFor,
  type TreeLease,
  type Session,
  canonicalLeasePr,
  renewAfterMs,
} from "./lease-model.ts";

import { type PathLock, LOCK_ACQUIRE_MAX_SEC, createLock } from "./lock.ts";

import { resolveActor } from "./actor.ts";

import { treeLeaseLock } from "./lease-files.ts";

import { join } from "node:path";

import { readFileSync, rmSync } from "node:fs";

import { randomBytes } from "node:crypto";

import { atomicWrite } from "./fsutil.ts";

import { hostname } from "node:os";

/**
 * The read-only half of the DEFERRED sessionless case's tree-wide check
 *, shared by the PREFLIGHT (`checkNoForeignSessionInTree`,
 * called directly by `claimLease`'s deferred branch) and the FENCE
 * (`acquireSessionlessTreeGuardNow`) — same evidence, same refusal,
 * different callers.
 *
 * Reached only when `claimLease` deferred (`{ lease: null, treeLease: null
 * }`): this tree's own per-PR lease already belongs to a live identified
 * session, so tier 3 claims nothing of its own here either — see
 * `claimLease`'s own tier-3 branch — and the only question left to ask is
 * whether the tree lease shows someone else already driving here. Every
 * OTHER tier-3 admission claims a tree lease of its own
 * (`claimSessionlessTreeLease`) and is fenced by
 * `assertTreeLeaseUnchanged` instead, the same fence an identified session
 * gets.
 *
 * Fails closed on an unreadable-but-fresh file the identical way
 * `claimTreeLease`'s own writer path does (`treeLeaseUnreadableAndFresh`): a
 * record that exists but cannot be parsed is evidence SOME session wrote it,
 * and `readTreeLease` collapsing that to `null` must not read as "nobody is
 * here" for a sessionless caller either.
 */
function checkNoForeignSessionInTree(path: string): void {
  if (treeLeaseUnreadableAndFresh(path)) {
    // Exit 11, not a generic 1 — the SAME exit this function's own confirmed
    // case a few lines down uses ("this working tree is already being driven
    // by a live session"). Not `DRIVE_HELD_ELSEWHERE_EXIT` (13): that code
    // names the PR-wide gate's cross-TREE refusal, a different question from
    // this tree-wide, within-this-tree one — using it here would trade one
    // inconsistency (an unnamed 1) for a worse one (11 and 13 both meaning
    // "another session already holds THIS tree" in the same function).
    fail(
      11,
      `drive-state.ts: this working tree's TREE lease exists but could not be read as one:`,
      `  ${path}`,
      "",
      "Refusing to treat unreadable as absent. This process could not identify",
      "its own session, so it cannot take a lease of its own to compare against —",
      "but a record that exists and cannot be parsed is exactly the evidence of",
      "whether another live session already holds this tree (mirroring",
      "the identified claim path's unreadable-and-fresh check).",
      "",
      `If it is debris, remove this file deliberately with your file tools: ${path}`,
      `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
      "without modification.",
    );
  }
  const held = readTreeLease(path);
  if (held === null || !leaseAlive(held)) return;
  // `held` is reached here ONLY via the DEFER path (this tree's own per-PR
  // lease already belongs to a live identified session on the SAME pr), so
  // in normal operation `held` is that same session's tree record — but a
  // holder-type branch is cheap insurance against the narrow edge case where
  // an operator's manual `rm`/debris cleanup left the two records out of
  // sync (`clear-lease` itself always drops both together), so this can
  // never print a fabricated "pid 0".
  if (held.holder === "worktree") {
    fail(
      11,
      `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr}.`,
      `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "This process could not identify its own session ($DRIVE_PR_SESSION and",
      "$CLAUDE_PID are both unset or dead), and a live sessionless resolver",
      "already holds this tree — mutating anyway would run beside it, in the",
      "same checkout.",
      "",
      leaseLivenessHint(held),
    );
  }
  fail(
    11,
    `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
    `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
    "",
    "This process could not identify its own session ($DRIVE_PR_SESSION and",
    "$CLAUDE_PID are both unset or dead), so it can take no lease of its own —",
    "but a live one already held here means mutating anyway would run beside",
    "it, in the same checkout.",
    "",
    leaseLivenessHint(held),
  );
}

/**
 * The FENCE half of the DEFERRED sessionless case: acquires `treeLeaseLock`
 * and runs `checkNoForeignSessionInTree` UNDER it, then returns the lock
 * STILL HELD for the caller to hand to `store.setExtraLock` — which keeps it
 * held through the mutation the fence guards, not merely through the check.
 *
 * Reached only when `claimLease` deferred (this tree's own per-PR lease
 * already belongs to a live identified session, so tier 3 claimed no tree
 * lease of its own either — see `claimLease`'s own tier-3 branch). Every
 * OTHER tier-3 admission claims a `TreeLease` of its own
 * (`claimSessionlessTreeLease`) and is fenced by
 * `acquireIdentifiedTreeGuardNow` below instead, the same fence an
 * identified session gets — that function's name is not literal (it fences
 * ANY admitted `TreeLease`, not only one an identified session wrote).
 *
 * That "through the mutation" part is the whole point. A plain re-check under
 * a lock that releases immediately after answering still leaves a gap: this
 * command holds only ITS OWN pr's state mutex, while `claimTreeLease`'s own
 * takeover/creation for a DIFFERENT pr takes THAT pr's mutex — never this
 * one — before reaching for `treeLeaseLock`. So a foreign claim can land in
 * the instant between "the fence said clear" and "the mutation actually
 * ran", and both proceed in the same checkout regardless of how carefully
 * the check itself was synchronized. Holding `treeLeaseLock` across that
 * whole window is what closes it: any `claimTreeLease` call for ANY pr in
 * this tree needs the SAME lock before it can write, so it queues behind
 * this command's entire critical section instead of slipping into the gap
 * after the check.
 *
 * Lock order is state-mutex(thisPr) → `treeLeaseLock` — `locked` has
 * already acquired the state mutex before `runFence` ever runs, and this
 * acquires `treeLeaseLock` only after that — the SAME order `claimTreeLease`
 * itself uses (state-mutex(X) → `treeLeaseLock`) whenever X happens to equal
 * thisPr, so two commands can never each hold the lock the other is waiting
 * on.
 */
export async function acquireSessionlessTreeGuardNow(
  stateDir: string,
): Promise<PathLock> {
  const actor = await resolveActor();
  const path = treeLeasePathFor(stateDir, actor);
  const lock = treeLeaseLock(path);
  // EXPLICIT bound, not the bare default — see this function's own comment on
  // why "no caller-settable deadline" is a real, if narrow, concern:
  // `acquire()`'s implicit default reads `$DRIVE_PR_LOCK_TIMEOUT`, a
  // PROCESS-WIDE env var that can be raised for an unrelated outer
  // acquisition and would then silently inflate this NESTED one too, called
  // while the PR's own state mutex is already held — compounding the wait
  // every OTHER command on that PR queues behind.
  // Pinning it to `LOCK_ACQUIRE_MAX_SEC` — the same hard ceiling every lock
  // in this module is already bounded by — keeps this acquisition's worst
  // case fixed regardless of that env var. True cooperative cancellation
  // (an AbortSignal threaded from the caller) would bound it further and is
  // a larger, deferred change: no lock in this module accepts one today, and
  // adding the primitive is its own review surface.
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    checkNoForeignSessionInTree(path);
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;
}

/**
 * The counterpart of `acquireSessionlessTreeGuardNow` for every admission
 * that carries a genuine `TreeLease` token:
 * acquires `treeLeaseLock`, runs `assertTreeLeaseUnchanged` UNDER it, then
 * returns the lock STILL HELD for the caller to hand to
 * `store.setExtraLock` — the identical "through the mutation, not just the
 * check" guarantee the sessionless branch has.
 *
 * Reached for an IDENTIFIED session — hence the name — and for tier 3's own
 * `holder: 'worktree'` claim too (`claimSessionlessTreeLease`): either way,
 * admission left this call site an actual `TreeLease` to compare against, so it
 * re-checks via `assertTreeLeaseUnchanged` rather than asking
 * `checkNoForeignSessionInTree`'s coarser "is anyone here at all" question —
 * but a point-in-time re-check with the lock released right after still leaves
 * the identical gap open: a DIFFERENT pr's claim (`claimTreeLease` or
 * `claimSessionlessTreeLease`) takes only THAT pr's state mutex before reaching
 * for `treeLeaseLock`, so it can land between "the fence found no takeover" and
 * "the mutation actually ran", the same gap the deferred sessionless caller
 * faces. Holding the lock across that whole window closes it here too, by the
 * same reasoning — for either ladder tier.
 *
 * Lock order is the same: state-mutex(thisPr) → `treeLeaseLock` — this
 * command already holds its own pr's state mutex by the time `runFence`
 * runs, and only reaches for `treeLeaseLock` after that, so it can never
 * deadlock against a `claimTreeLease` call that takes the SAME two locks in
 * the SAME order for a different pr.
 */
export async function acquireIdentifiedTreeGuardNow(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): Promise<PathLock> {
  const path = treeLeasePathFor(stateDir, actor);
  const lock = treeLeaseLock(path);
  // EXPLICIT bound — see `acquireSessionlessTreeGuardNow`'s identical
  // comment; the same reasoning applies unchanged here.
  await lock.acquire(LOCK_ACQUIRE_MAX_SEC);
  try {
    assertTreeLeaseUnchanged(stateDir, actor, admitted);
  } catch (e) {
    lock.release();
    lock.dispose();
    throw e;
  }
  return lock;
}

/**
 * Take or renew this session's TREE-WIDE lease — admits at most one
 * live session per WORKING TREE, whichever PR it names, closing the gap the
 * per-PR lease alone leaves open: two interactive sessions in one tree driving
 * TWO DIFFERENT PRs resolve two different `leasePathFor` files and never meet,
 * so neither refuses the other, even though they share one checkout they can
 * both edit, commit, and push.
 *
 * Mirrors the per-PR claim below — same fast path, same takeover refusal (exit
 * 11), same renewal-preserves-generation rule — over a lease file keyed by
 * ACTOR ALONE rather than (actor, pr). That is what closes the race a per-PR
 * mutex cannot: every claim in this tree, whichever PR it is for, serialises
 * on the SAME lock file (`treeLeaseLock`), where a create-vs-create race
 * between two different PRs would otherwise need a mutex the two never share
 * (each PR's `store.locked` section is keyed by that PR alone).
 *
 * A TAKEOVER (this session's own generation, minted fresh because the prior
 * holder is foreign and dead, or because there was none) additionally takes
 * THIS CALL'S OWN `pr`'s state mutex — the identical "mints a new generation
 * takes the state mutex" rule the per-PR claim below applies to itself, for
 * the identical reason: without it, a takeover here can land WHILE an
 * already-admitted command for that same PR is still inside its locked
 * section (its session killed mid-mutation, the subprocess still finishing),
 * and `assertTreeLeaseUnchanged` then refuses that command's OWN fence check
 * on the way out — turning a harmless, already-in-flight completion into a
 * spurious refusal (measured: `a dead-pid takeover cannot land while a
 * command holds the state mutex` red under a takeover with no such
 * coordination). Taking that PR's mutex here makes the takeover wait out
 * exactly that command, the same ordering guarantee the per-PR lease already
 * gives its own admission.
 *
 * Scoped to `pr` ALONE, and that is a real, stated boundary rather than full
 * coverage: a takeover for a DIFFERENT pr than the one an in-flight command
 * is finishing does not wait on it, because there is no single mutex that
 * spans every PR a tree might be mid-flight on. The residual is narrow — it
 * needs a session to die mid-mutation on PR X at the same moment a takeover
 * begins for a DIFFERENT PR Y in the same tree — and bounded the same way the
 * per-PR hazard always was: the takeover can only happen once THIS lease's
 * own staleness test has judged the previous holder abandoned, so the
 * exposure is to a session already presumed gone, not a live one.
 *
 * Called first, before the per-PR claim: a conflict here means the caller
 * never reaches — or writes — its own per-PR lease at all.
 */
/**
 * What `claimTreeLease` returns: the lease itself, plus the raw bytes a
 * ROLLBACK needs — NOT the parsed identity (pid, host, generation) the first
 * `rollbackTreeLease` compared.
 *
 * Two concurrent commands from the SAME session share (pid, host,
 * generation) identically whenever a renewal preserves the generation —
 * DELIBERATELY, since that identity is what lets one session juggle several
 * PRs from one tree without refusing itself. So identity alone cannot tell
 * "the write THIS call made" apart from "a sibling call's write, from the
 * same session" — a rollback keyed on it can restore a stale snapshot over,
 * or outright delete, a sibling's successful admission (measured: two
 * siblings racing a tree lease's CREATION can both capture `before: null`
 * from the same pre-write instant, and the loser's rollback then deletes the
 * winner's lease entirely). The next fix was a compare-and-swap on the
 * EXACT BYTES this call wrote, captured and compared while holding the SAME
 * lock the write itself used — never derived from a snapshot read outside
 * it.
 *
 * A later fix narrowed that comparison further: `lastSeen`'s millisecond
 * resolution lets two writes from the same session, same pr, same command
 * tie, producing byte-for-byte identical JSON — which made the raw-bytes CAS
 * itself ambiguous between "still my write" and "a sibling's later write
 * that happens to match". `wroteRaw` is
 * kept for the actual write/restore, but `rollbackTreeLease` now identifies
 * "the write THIS call made" by the fresh, per-write-only `revision` field
 * embedded in it, parsed and compared explicitly rather than assumed unique
 * by virtue of the bytes around it.
 *
 * `wroteRaw` is `null` on the fast path: no write happened, so there is
 * nothing for a rollback to undo. `beforeRaw` is only meaningful when
 * `wroteRaw` is not `null`, and is `null` there when nothing existed at this
 * path immediately before this call's write.
 */
interface TreeLeaseClaim {
  lease: TreeLease;
  wroteRaw: string | null;
  beforeRaw: string | null;
}

/**
 * `isMine`'s counterpart for the TREE-WIDE file specifically: is
 * `held` THIS caller's own claim?
 *
 * `isMine` itself is correct for the file it was built for — the PER-PR
 * presence record, already scoped to (tree, pr) by its own filename, where
 * actor equality is the only remaining question. Reused UNMODIFIED against
 * the TREE-WIDE file, it answers a DIFFERENT and wrong question: that file
 * is ONE PER TREE, covering every pr the tree might drive, and `isMine`'s
 * `holder === 'worktree'` branch does not even consult its `Session`
 * argument — so every caller in this tree, whichever pr it names, would
 * read a live `holder: 'worktree'` TREE record as its own. Tier 3 writes
 * `holder: 'worktree'` records to this SAME file, so `claimTreeLease` — and
 * the irreversible-post fence, `assertTreeMutationAllowed` — meeting one
 * needs a different test: an identified session claiming PR 888 would
 * otherwise silently take over, with no refusal and no takeover diagnostic,
 * a LIVE sessionless resolver's tree-wide claim on PR 999 in the same tree —
 * the exact cross-shipping hazard this whole mechanism exists to close,
 * reopened by treating that record shape as automatically "mine".
 *
 * The rule mirrors `claimSessionlessTreeLease`'s own `samePr` reasoning: a
 * `holder: 'worktree'` record names a SPECIFIC pr, so ownership of it turns
 * on THAT pr matching the caller's, not on sharing a tree. A match is a
 * deliberate, intentional smooth handoff — the tree-wide mirror of the
 * per-PR rule that "an identified session may take over its own tree's
 * presence record freely, because that record is not a claim about
 * sessions" — so an identified session finishing what a sessionless
 * resolver started on the SAME pr upgrades it without a refusal or a
 * takeover diagnostic. A mismatch
 * — or no pr to compare at all (`pr === null`, `assertTreeMutationAllowed`'s
 * standalone `assert-post-allowed.ts` caller with no PR in play) — is never
 * "mine", and falls through to the ordinary live-refuse / stale-takeover
 * path, symmetric with how `claimSessionlessTreeLease` already treats a
 * foreign SESSION-held record.
 *
 * For `held.holder === 'session'`, ownership is exactly `isMine`.
 */
export function treeIsMine(
  held: TreeLease,
  session: Session,
  actor: string,
  pr: string | null,
): boolean {
  if (held.holder === "worktree") {
    return pr !== null && held.pr === canonicalLeasePr(pr);
  }
  return isMine(held, session, actor);
}

export async function claimTreeLease(
  stateDir: string,
  actor: string,
  session: Session,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const path = treeLeasePathFor(stateDir, actor);

  // Fast path — see the per-PR claim's own comment on why this is not merely
  // an optimisation: `claim-held` fans out one process per key, and each of
  // those legitimately renews this same tree lease concurrently.
  //
  // `seen.pr === canonicalPr` is REQUIRED here, not just `isMine` — this
  // session's OWN previous claim may have been for a DIFFERENT pr (one
  // session juggling several PRs from one tree), and the fast path returns
  // `seen` UNCHANGED with no write, so skipping this check would report the
  // PREVIOUS pr in every diagnostic and refusal until the lease next goes
  // through the locked path for some other reason.
  //
  // `seen.holder === 'session'` is ALSO required, and is not implied by
  // `treeIsMine` — that predicate answers "mine" for a `holder: 'worktree'`
  // record on a MATCHING pr too, but "mine" there means "I may UPGRADE this
  // record", not "this record already IS what I would write". Returning
  // `seen` unchanged in that case would leave the file `holder: 'worktree'`,
  // `pid: 0` forever — this session's own admission would then compare
  // (0, host, generation) against itself in every later fence, and the
  // record would never actually reflect that an identified session is now
  // driving. An upgrade always takes the locked path
  // below, which writes the converted record — see `mine`'s own comment.
  const seen = readTreeLease(path);
  const fresh = freshTreeClaim(seen, "session", canonicalPr, (seen) =>
    treeIsMine(seen, session, actor, pr),
  );
  if (fresh !== null) return fresh;

  // `isRecycledPid` overrides `leaseAlive` here for the identical reason the
  // per-PR claim's own `mintsNewGeneration` does: once the OS hands a dead
  // predecessor's exact pid to this new session, `leaseAlive`'s pid check is
  // asking whether THIS process is running — tautologically yes — and says
  // nothing about the dead predecessor `isMine` has already proven wrote
  // `seen` (the tree-lease claim once omitted this, blocking every PR in the
  // checkout until the stale lease aged out instead of recognizing the
  // takeover it actually was). Never true for a `holder: 'worktree'` `seen`
  // — `isRecycledPid` fails its own pid-match guard against pid 0 — so it is
  // harmless dead weight there, not a hazard.
  const mintsNewGeneration =
    seen === null ||
    (!treeIsMine(seen, session, actor, pr) &&
      (isRecycledPid(seen, session, actor) || !leaseAlive(seen)));
  return await withTreeStateLock(stateDir, pr, mintsNewGeneration, underLock);

  async function underLock(holdState: boolean): Promise<TreeLeaseClaim> {
    return await withTreeLeaseFile(
      path,
      [
        "Refusing to treat unreadable as absent. That file is exactly the evidence",
        "of whether another live session already holds this tree, so admitting a",
        "takeover here would be a claim this process could not actually verify",
        "(mirroring the PR-wide gate's unreadableLeaseFilesFor).",
      ],
      async (lock, beforeRaw, held) => {
        const mine = held !== null && treeIsMine(held, session, actor, pr);
        // Same restart-under-both-locks rule as the per-PR claim: the unlocked
        // peek above can be stale by the time this lock is held. `isRecycledPid`
        // is threaded through here too — see `mintsNewGeneration`'s own comment
        // above for why `leaseAlive` alone is the wrong test once the pid has
        // been recycled onto this very caller.
        if (
          !holdState &&
          (held === null ||
            (!mine &&
              (!leaseAlive(held) || isRecycledPid(held, session, actor))))
        ) {
          lock.release();
          lock.dispose();
          return await withTreeStateLock(stateDir, pr, true, underLock);
        }
        if (held !== null && !mine)
          reportIdentifiedTreeTakeover(held, session, actor, pr, canonicalPr);
        const lease: TreeLease = {
          ...leaseForClaim(
            "session",
            session,
            actor,
            worktree,
            command,
            held,
            mine,
          ),
          pr: canonicalPr,
          revision: randomBytes(16).toString("hex"),
        };
        return writeTreeClaim(path, lease, beforeRaw);
      },
    );
  }
}

/**
 * Undo a `claimTreeLease` write when the per-PR claim that followed it
 * failed — restores `beforeRaw` (or removes the
 * file, when `beforeRaw` is `null`), but ONLY if the file on disk still holds
 * THIS call's own write.
 *
 * That compare-and-swap is load-bearing, not decoration — see
 * `TreeLeaseClaim`'s own comment for the concurrent-sibling hazard it closes
 * that an identity-based check (the first version's `(pid, host, generation)`
 * comparison) could not: two writes from the same session are
 * indistinguishable by identity alone. Earlier versions compared raw
 * serialized BYTES instead, reasoning that every write stamps a fresh
 * `lastSeen` — true, but `lastSeen` only has millisecond resolution, so two
 * writes from the same session, same pr, same command, with `generation`
 * preserved by a renewal, CAN tie on it and produce byte-for-byte identical
 * JSON. A rollback keyed on raw bytes then can't tell "the write THIS call
 * made" apart from a sibling's later, coincidentally identical one, and can
 * revert or delete a successfully admitted sibling. The comparison is
 * therefore on `revision` — a fresh random token stamped on EVERY write,
 * never preserved across a renewal, whose only job is telling writes apart —
 * parsed from both sides rather than compared as bytes, so an incidental
 * whitespace/key-order difference could never make two DIFFERENT writes look
 * unequal either.
 */
export async function rollbackTreeLease(
  path: string,
  wroteRaw: string,
  beforeRaw: string | null,
): Promise<void> {
  const wrote = parseTreeLease(wroteRaw);
  // `wroteRaw` is always this module's own just-serialized write — a
  // moment ago, under this same lock — so it must parse; if it somehow does
  // not, there is no `revision` to compare against and rolling back on raw
  // bytes alone would reintroduce the exact ambiguity this fix closes.
  if (wrote === null) return;
  const lock = treeLeaseLock(path);
  await lock.acquire();
  try {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return; // gone already — nothing to swap out from under
    }
    const currentParsed = parseTreeLease(current);
    if (currentParsed === null || currentParsed.revision !== wrote.revision) {
      return; // someone else's write since — leave it
    }
    if (beforeRaw === null) {
      rmSync(path, { force: true });
    } else {
      atomicWrite(path, beforeRaw);
    }
  } finally {
    lock.release();
    lock.dispose();
  }
}

/**
 * Ladder tier 3's own claim of the TREE-WIDE lease — the
 * `holder: 'worktree'` presence-record pattern of the per-PR axis, extended
 * to the tree-wide axis for the sessionless tier: a durable record at the
 * SAME path an identified session's `claimTreeLease` writes to
 * (`treeLeasePathFor`), so a second sessionless resolver in this tree — even
 * one driving a DIFFERENT pr — finds something to read.
 *
 * `isMine` cannot decide ownership here, and that is why this is a separate
 * function rather than a `claimTreeLease` branch: `isMine`'s `holder ===
 * 'worktree'` case answers `actor === actor`, which is exactly right for the
 * PER-PR presence record — that file is already scoped to (tree, pr) by its
 * own name, so actor equality is the only question left — but this file is
 * ONE PER TREE, covering every pr the tree might drive, so actor equality
 * alone would treat every sessionless caller in this tree as the SAME owner,
 * whichever pr it names. Two sessionless callers driving different PRs
 * from one tree is precisely what this lease must refuse, so ownership here
 * turns on `pr` too: a live record for THIS pr is a renewal,
 * a live record for ANY OTHER pr — or a live SESSION-held record, whichever
 * pr it names — is foreign.
 *
 * That is a real, stated cost, not a free extension: a sessionless resolver
 * that finishes with PR X and moves straight to PR Y, with no intervening
 * `clear-lease` and no full staleness window elapsed, is refused —
 * indistinguishable, on the evidence this runtime provides, from a SECOND
 * sessionless resolver that happens to start on PR Y while the first is
 * still working PR X (`claimLease`'s own tier-3 comment states the identical
 * trade for the per-PR axis; this is the same trade, paid again on the tree
 * axis, for the same reason — no identity the runtime does not supply). Two
 * remedies already exist and need nothing new: `clear-lease` drops this
 * record unconditionally regardless of which pr it names (see its own
 * comment), so it is the documented way to move on immediately; left alone,
 * the record clears itself the same way every tier-3 record does, once
 * `leaseStaleMin`m pass with no mutating command.
 *
 * Mirrors `claimTreeLease`'s own structure closely on purpose — same fast
 * path, same unreadable-but-fresh fail-closed check, same
 * mints-a-new-generation-takes-the-state-mutex rule, same
 * rollback-on-later-failure contract via the returned `TreeLeaseClaim` — so
 * `claimLease`'s tier-3 branch below can call this the same way its
 * identified branch calls `claimTreeLease`, rather than growing a differently
 * shaped protocol that would have to be reasoned about from scratch.
 */
export async function claimSessionlessTreeLease(
  stateDir: string,
  actor: string,
  worktree: string,
  pr: string,
  command: string,
): Promise<TreeLeaseClaim> {
  const canonicalPr = canonicalLeasePr(pr);
  const path = treeLeasePathFor(stateDir, actor);

  // Fast path — mirrors `claimTreeLease`'s own: this call's OWN previous
  // claim may have been for a DIFFERENT pr (one resolver working several PRs
  // from one tree, in sequence, with `clear-lease` or staleness between
  // them), so `seen.pr === canonicalPr` is required here too, not merely
  // `seen.holder === 'worktree'` — skipping it would report the PREVIOUS pr
  // in every diagnostic until the lease next goes through the locked path.
  const seen = readTreeLease(path);
  const fresh = freshTreeClaim(seen, "worktree", canonicalPr, () => true);
  if (fresh !== null) return fresh;

  // A live record — session-held, or worktree-held for a DIFFERENT pr — is
  // never a takeover on the strength of THIS unlocked peek alone; only a
  // genuinely dead-looking one mints a new generation and needs the state
  // mutex, matching `claimTreeLease`'s own `mintsNewGeneration` (`!isMine &&
  // (isRecycledPid || !leaseAlive)`) with the ownership half swapped for the
  // pr-based test this record uses instead of `isMine`.
  const mintsNewGeneration =
    seen === null ||
    (!(seen.holder === "worktree" && seen.pr === canonicalPr) &&
      !leaseAlive(seen));
  return await withTreeStateLock(stateDir, pr, mintsNewGeneration, underLock);

  async function underLock(holdState: boolean): Promise<TreeLeaseClaim> {
    return await withTreeLeaseFile(
      path,
      [
        "Refusing to treat unreadable as absent. This process could not identify",
        "its own session, so it cannot take a lease of its own to compare against —",
        "but a record that exists and cannot be parsed is exactly the evidence of",
        "whether another live claimant already holds this tree (mirroring",
        "the identified claim path's unreadable-and-fresh check).",
      ],
      async (lock, beforeRaw, held) => {
        const samePr =
          held !== null &&
          held.holder === "worktree" &&
          held.pr === canonicalPr;
        // Restart under both locks: the unlocked peek above can be stale by
        // the time this lock is held — mirrors `claimTreeLease`'s own restart
        // condition, minus the recycled-pid concern, which does not apply to
        // a holder that never carries a pid in the first place.
        if (!holdState && (held === null || (!samePr && !leaseAlive(held)))) {
          lock.release();
          lock.dispose();
          return await withTreeStateLock(stateDir, pr, true, underLock);
        }
        if (held !== null && !samePr)
          reportSessionlessTreeTakeover(held, pr, canonicalPr);
        const lease: TreeLease = {
          ...leaseForClaim(
            "worktree",
            { pid: 0, host: hostname(), sessionStarted: "", source: "none" },
            actor,
            worktree,
            command,
            held,
            samePr,
          ),
          pr: canonicalPr,
          revision: randomBytes(16).toString("hex"),
        };
        return writeTreeClaim(path, lease, beforeRaw);
      },
    );
  }
}

/**
 * `assertLeaseUnchanged`'s counterpart for the TREE lease: is the
 * tree-wide lease this command was admitted on still the one on disk, now
 * that it finally holds the state mutex?
 *
 * Needed for the identical reason `assertLeaseUnchanged` is: admission and
 * mutation are not the same instant, and everything that can revoke a tree
 * lease's admission — a takeover once its holder goes stale, an operator's
 * `clear-lease` — happens in the gap between admission (`claimTreeLease` for
 * an identified session, `claimSessionlessTreeLease` for tier 3)
 * returning and the command's queued mutation actually running. Either
 * writer's own state-mutex coordination during a takeover (see its own
 * comment) closes that gap only for a takeover that targets the SAME pr an
 * in-flight command is mid-mutation on; a takeover for a DIFFERENT pr in
 * this tree is not ordered against that command at all, and THIS fence is
 * what catches it — run alongside `assertLeaseUnchanged` inside every locked
 * section (`drive-state.ts`'s `LEASED_COMMANDS` wiring), never on its own —
 * the two questions are independent and a command that fails either must not
 * proceed.
 */
export function assertTreeLeaseUnchanged(
  stateDir: string,
  actor: string,
  admitted: TreeLease,
): void {
  const held = readTreeLease(treeLeasePathFor(stateDir, actor));
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
    `drive-state.ts: this working tree's TREE lease (admitted for PR #${admitted.pr}) was taken over while this command waited for the state lock.`,
    // Named ONLY as "gone" — not attributed to `clear-lease` specifically.
    // That was this module's own most-visible way to reach `held === null`,
    // but not the only one: an operator can `rm` the file directly (the
    // documented remedy for unreadable debris), and a same-session
    // rollback can delete it too.
    // Naming a SPECIFIC cause this fence cannot actually verify would mislead
    // more than it helps.
    held === null
      ? "The lease this command was admitted on is gone."
      : `It now belongs to ${leaseHolderLabel(held)} (since ${held.startedAt}, PR #${held.pr}).`,
    "",
    "Refusing to mutate: the session that took it over may already be working,",
    "and two writers in one tree can cross-ship uncommitted edits.",
    "Nothing was written.",
    "",
    "Re-run the command if you still hold the drive; the takeover is only",
    "authoritative if that other session is genuinely driving this tree.",
  );
}

async function withTreeStateLock(
  stateDir: string,
  pr: string,
  holdState: boolean,
  underLock: (holdState: boolean) => Promise<TreeLeaseClaim>,
): Promise<TreeLeaseClaim> {
  const stateLock = holdState
    ? createLock(join(stateDir, `drive-pr-${pr}.json`), "drive-state.ts", pr)
    : null;
  if (stateLock) await stateLock.acquire();
  try {
    return await underLock(holdState);
  } finally {
    if (stateLock) {
      stateLock.release();
      stateLock.dispose();
    }
  }
}

function reportIdentifiedTreeTakeover(
  held: TreeLease,
  session: Session,
  actor: string,
  pr: string,
  canonicalPr: string,
): void {
  // `isRecycledPid` overrides `leaseAlive` here for the same reason it
  // overrides it in `mintsNewGeneration`: once `held.pid ===
  // session.pid`, `leaseAlive`'s pid check is asking whether THIS
  // process is running, which is tautologically true and says nothing
  // about the dead predecessor `isMine` has already proven wrote `held`.
  // Never true for a `holder: 'worktree'` `held` — see `mintsNewGeneration`'s
  // own note.
  if (leaseAlive(held) && !isRecycledPid(held, session, actor)) {
    if (held.holder === "worktree") {
      // The direction of the hazard `treeIsMine` closes: this
      // identified session's own pr differs from the live sessionless
      // resolver's, so it is foreign, not an upgrade — refuse exactly
      // as `claimSessionlessTreeLease` refuses the mirror case, naming
      // no pid (there is none) rather than fabricating one.
      fail(
        11,
        `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
        `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "This identified session and that sessionless resolver share the same",
        "checkout: they can edit and commit the same files concurrently, and",
        "one resolver's uncommitted changes can be pushed to the other's PR.",
        "Refusing to be the second.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
        "Otherwise the tree's presence record clears itself once that resolver",
        `has left drive state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `drive-state.ts: this working tree is already being driven by another live session (pid ${held.pid} on ${held.host || "this host"}) — it is on PR #${held.pr}, this command is for PR #${canonicalPr}.`,
      `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two sessions in ONE tree — even driving different PRs — share the same",
      "checkout: they can edit and commit the same files concurrently, and one",
      "session's uncommitted changes can be pushed to the other's PR. Refusing",
      "to be the second.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      "Otherwise the tree lease clears itself once that session has left drive",
      `state untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    held.holder === "worktree"
      ? `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`
      : isRecycledPid(held, session, actor)
        ? `drive-state.ts: took over a TREE lease whose pid (${held.pid}) the OS has recycled for this new, unrelated session (previous session last mutated drive state ${ageLabel(held.lastSeen)}, was on PR #${held.pr}).`
        : `drive-state.ts: took over an abandoned TREE lease (session pid ${held.pid} is gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
  );
}

function reportSessionlessTreeTakeover(
  held: TreeLease,
  pr: string,
  canonicalPr: string,
): void {
  if (leaseAlive(held)) {
    if (held.holder === "session") {
      fail(
        11,
        `drive-state.ts: this working tree is already being driven by a live session (pid ${held.pid} on ${held.host || "this host"}, currently PR #${held.pr}).`,
        `It took the tree lease at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
        "",
        "This process could not identify its own session ($DRIVE_PR_SESSION and",
        "$CLAUDE_PID are both unset or dead), and a live IDENTIFIED session",
        "already holds this tree — writing a sessionless presence record over",
        "it would only downgrade what that session already represents, so this",
        "claims nothing here.",
        "",
        leaseLivenessHint(held),
        `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
        "Otherwise the tree lease clears itself once that session has left drive",
        `state untouched for ${leaseStaleMin()}m.`,
      );
    }
    fail(
      11,
      `drive-state.ts: this working tree already has a sessionless resolver active on PR #${held.pr} — this command is for PR #${canonicalPr}.`,
      `It took the tree's presence record at ${held.startedAt} and last mutated drive state ${ageLabel(held.lastSeen)} ('${held.command}').`,
      "",
      "Two sessionless resolvers in ONE tree — even driving different PRs —",
      "share the same checkout: they can edit and commit the same files",
      "concurrently, and one resolver's uncommitted changes can be pushed to",
      "the other PR. Refusing to be the second.",
      "",
      leaseLivenessHint(held),
      `If it is gone, or you are taking over deliberately:  drive-state.ts clear-lease ${pr}`,
      "Otherwise the tree's presence record clears itself once that resolver",
      `has left drive state untouched for ${leaseStaleMin()}m.`,
    );
  }
  console.error(
    held.holder === "session"
      ? `drive-state.ts: took over a TREE lease whose session (pid ${held.pid}) is gone or idle since ${held.lastSeen} (was on PR #${held.pr}).`
      : `drive-state.ts: took over an abandoned TREE presence record (a sessionless resolver, gone or idle since ${held.lastSeen}, was on PR #${held.pr}).`,
  );
}

function readTreePreimage(path: string): {
  beforeRaw: string | null;
  held: TreeLease | null;
} {
  let beforeRaw: string | null;
  try {
    beforeRaw = readFileSync(path, "utf8");
  } catch {
    beforeRaw = null;
  }
  return {
    beforeRaw,
    held: beforeRaw === null ? null : parseTreeLease(beforeRaw),
  };
}

function writeTreeClaim(
  path: string,
  lease: TreeLease,
  beforeRaw: string | null,
): TreeLeaseClaim {
  const wroteRaw = `${JSON.stringify(lease, null, 2)}\n`;
  atomicWrite(path, wroteRaw);
  return { lease, wroteRaw, beforeRaw };
}

function freshTreeClaim(
  seen: TreeLease | null,
  holder: TreeLease["holder"],
  pr: string,
  owns: (seen: TreeLease) => boolean,
): TreeLeaseClaim | null {
  if (
    seen === null ||
    seen.holder !== holder ||
    !owns(seen) ||
    seen.pr !== pr ||
    !(Date.now() - Date.parse(seen.lastSeen) < renewAfterMs())
  )
    return null;
  return { lease: seen, wroteRaw: null, beforeRaw: null };
}

function assertTreeClaimReadable(path: string, reason: string[]): void {
  if (!treeLeaseUnreadableAndFresh(path)) return;
  fail(
    11,
    `drive-state.ts: this working tree's TREE lease exists but could not be read as one:`,
    `  ${path}`,
    "",
    ...reason,
    "",
    `If it is debris, remove this file deliberately with your file tools: ${path}`,
    `Otherwise it stops blocking on its own once ${leaseStaleMin()}m pass`,
    "without modification.",
  );
}

/** Read and write one tree lease under its file lock, including a rollback preimage. */
async function withTreeLeaseFile(
  path: string,
  unreadableReason: string[],
  action: (
    lock: PathLock,
    beforeRaw: string | null,
    held: TreeLease | null,
  ) => Promise<TreeLeaseClaim>,
): Promise<TreeLeaseClaim> {
  const lock = treeLeaseLock(path);
  await lock.acquire();
  try {
    assertTreeClaimReadable(path, unreadableReason);
    const { beforeRaw, held } = readTreePreimage(path);
    return await action(lock, beforeRaw, held);
  } finally {
    lock.release();
    lock.dispose();
  }
}

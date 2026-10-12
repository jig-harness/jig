/**
 * Who "this driver" is, for the state file's purposes.
 *
 * `drive-state.ts` is shared by every driver working one PR: the store lives in
 * the clone-wide git dir (`store.ts`'s `--git-common-dir`) precisely so two
 * Conductor worktrees driving the same PR see one round budget, one parked set
 * and one held batch. That sharing is what makes a PR-global `verifiedSha`
 * unsafe as push provenance — driver B's `stamp-held` moves a pointer driver
 * A's held thread then reads as vouching for A's own unpushed fix.
 * Distinguishing the two needs an identity the state model did not have.
 *
 * The identity is the WORKING TREE. `drive.ts` holds a single-instance lock
 * keyed by the same tree (`store.ts`'s `worktreeLockName`, which shares this
 * file's `worktreeKey`), so at most one driver runs per tree at a time — which
 * is what makes a tree a sound stand-in for a driver, and a Conductor worktree
 * a separate identity. That is exactly the topology the cross-resolve bug lives
 * in.
 *
 * Sound CONCURRENTLY, not across time, and the difference is worth stating
 * because the state file outlives worktrees — being clone-wide is the premise
 * of the whole bug. A Conductor workspace deleted and recreated at the same
 * path is routine, and derives the same key, so a genuinely new driver inherits
 * its dead predecessor's identity and its `stamp-held` will stamp that
 * predecessor's leftover holds. Round equality is the remaining guard there
 * (§ 3's reconciliation normally clears such an entry long before), and closing
 * it properly would mean a per-process id that no longer survives the crash
 * recovery this state file exists for — the wrong trade for a residual whose
 * blast radius is one stale hold in a tree nobody is driving from any more.
 *
 * `hold` and `stamp-held` derive this and accept no override: an identity
 * whose whole purpose is to tell two concurrent drivers apart must not be
 * settable, for the reason `worktreeLockName` states about its own key. A test
 * that needs two actors makes two real worktrees, which is also the only way to
 * test the derivation rather than a stand-in for it. `restore-held` is the one
 * command that takes an actor as an argument, and deliberately so — it is
 * putting back an id `claim-held` printed moments earlier, and re-deriving
 * there would launder ownership onto the restoring tree; see its own comment in
 * `drive-state.ts`.
 */

import { createHash } from "node:crypto";
import { fail } from "../cli.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";

let cachedRoot: Promise<string> | null = null;

/**
 * The working tree's own path, unhashed.
 *
 * DIAGNOSTIC ONLY — never an identity. `worktreeKey` below is what anything
 * compares, and the two must not be confused: a path is not filename-safe, and
 * two paths that differ only by a symlink hop name one tree.
 *
 * It exists because the hash cannot be un-hashed, and a cross-worktree refusal
 * that can only say `wt-3f9c…` tells the reader which tree is driving in a form
 * they cannot act on — they cannot `cd` to a hash to stop that session or clear
 * its lease. So the lease RECORDS this path (`Lease.worktree`) alongside the
 * actor, purely so the refusal and the `lease --all` report can name a place
 *.
 */
export async function worktreeRoot(): Promise<string> {
  // Memoised per PROCESS, and only on success. A process cannot change which
  // working tree it is in, so the second `git rev-parse` can only ever repeat
  // the first — and it is not free: `claimLease` resolves the actor on every
  // mutating command, and `reset` used to spawn it while HOLDING the state
  // mutex, serialising a subprocess behind the lock every other command waits
  // on. Caching the promise rather than the value also
  // collapses concurrent callers — `claim-held` fans out one per key — onto a
  // single spawn.
  //
  // A FAILED resolution is deliberately not cached, and the memo now ENFORCES
  // that rather than asserting it. It used to store the pending promise and
  // claim the point was moot because `fail()` exits — but `fail()` throws
  // `ExitError`, it does not exit, so a rejection stayed in the memo and every
  // later caller in that process got the same rejection replayed. Terminal
  // today, and wrong the moment the failure path becomes recoverable, which is
  // exactly the invariant the comment was there to protect.
  if (cachedRoot !== null) return cachedRoot;
  const pending = resolveWorktreeRoot().catch((e: unknown) => {
    // Only clear a memo that is still OURS: a concurrent caller may already
    // have installed a fresh attempt, and nulling that one would drop a
    // resolution in flight.
    if (cachedRoot === pending) cachedRoot = null;
    throw e;
  });
  cachedRoot = pending;
  return pending;
}

/**
 * A stable, filename-safe key for the current working tree.
 *
 * `--show-toplevel` rather than a git dir: a linked worktree has its own
 * toplevel (the granularity wanted here), while `--git-common-dir` is shared
 * across all of them by design — deriving from that would give every Conductor
 * worktree the SAME key and silently reinstate the bug this exists to close.
 *
 * Hashed because the input is a path: it carries separators, spaces and
 * non-ASCII on somebody's machine, and this value is written into JSON that a
 * human reads and into a lock file name.
 */
export async function worktreeKey(): Promise<string> {
  // Hashed here rather than inside the memo, so the cache holds the one thing
  // the git call actually produced and both consumers derive from the same
  // resolution. sha256 of a short path per call is immaterial next to the
  // subprocess the memo exists to avoid.
  return createHash("sha256")
    .update(await worktreeRoot())
    .digest("hex")
    .slice(0, 16);
}

async function resolveWorktreeRoot(): Promise<string> {
  // Anchored to `DRIVE_PR_WORKTREE` when a driver set one, for the same
  // reason `base-sync.ts` and `drive-status.ts` anchor their own root/HEAD
  // reads there: a pass is an agent with a persistent shell cwd, and a `cd`
  // elsewhere between tool calls would otherwise make this ambient
  // `--show-toplevel` name a DIFFERENT tree than the one the driver is
  // actually driving. Every caller of `resolveActor()`/`worktreeRoot()` feeds
  // into lease/hold attribution (`lib/state/lease.ts`), so an unanchored read
  // here mis-scopes the fence to the pass's wandering cwd rather than the
  // tree the merge/push actually mutates — able to race a second session in
  // the real tree, or falsely refuse on an unrelated lease in the wrong one
  //. Empty/unset falls back to the ambient cwd
  // exactly as before, matching every other `DRIVE_PR_WORKTREE` consumer.
  const anchor = process.env.DRIVE_PR_WORKTREE;
  // Deadlined: this runs on the SessionStart `--here` path (via
  // `worktreeLockName`), where a hung git on a stalled filesystem would
  // otherwise outlive the outer hook's timeout and turn "could not check"
  // into silence — the one thing the banner's contract forbids.
  // The env is scrubbed of GIT_DIR / GIT_WORK_TREE: a hook-launched driver
  // inherits them for another checkout and they outrank the cwd, so an
  // unscrubbed read would key the worktree lock (and every hold's actor) on
  // THAT checkout while `drive.ts` anchors its capture spawn to the real one
  // — two drives in the real tree could then hold different worktree locks.
  const r = await git(["rev-parse", "--show-toplevel"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
    ...(anchor ? { cwd: anchor } : {}),
  });
  const root = r.code === 0 ? r.stdout.trim() : "";
  if (root === "") {
    // No script name in this message: BOTH callers reach it — `drive.ts`, to
    // name its single-instance lock, and `drive-state.ts`, to attribute a hold.
    // Naming one of them (the pre-move text named `drive.ts`) mislabels the
    // other, and a refusal that tells a reader the wrong thing is running is
    // worse than one that tells them only what failed.
    fail(
      2,
      "cannot resolve the working tree root (not a git repository).",
      "This key identifies the working tree: it is both the lock that keeps two",
      "drivers out of one tree and the actor a hold is attributed to.",
      "Refusing to lock, or to record a hold, against a tree that cannot be named.",
    );
  }
  return root;
}

/**
 * The actor id stamped onto a hold and matched by `stamp-held`.
 *
 * Prefixed rather than a bare hash so a human reading the state file or the
 * handoff can tell what kind of thing it identifies without consulting this
 * module.
 */
export async function resolveActor(): Promise<string> {
  return `wt-${await worktreeKey()}`;
}

/**
 * Does `s` match the exact shape `resolveActor` produces — `wt-` plus 16
 * lowercase hex characters? `restore-held` is the one command that takes an
 * actor as an argument rather than deriving it, so it is the one place a
 * hand-composed value could name a different worktree (or carry a pipe/
 * backtick that corrupts the handoff's markdown table, which renders the
 * actor inside a backtick code span). Every legitimate caller passes back
 * exactly what `claim-held` printed, which is always this shape.
 */
export function isActorId(s: string): boolean {
  return /^wt-[0-9a-f]{16}$/.test(s);
}

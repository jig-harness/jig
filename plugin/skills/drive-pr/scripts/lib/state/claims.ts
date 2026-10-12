/**
 * Per-item claim over the HELD batch.
 *
 * `hold`/`held`/`release-held` serialise the JSON, but say nothing about who
 * may DISPATCH the external mutation for a held item — that call happens
 * entirely outside this process, between reading `held` and eventually
 * releasing the key. Two concurrent drivers reading the same snapshot could
 * both decide to process the same item and both dispatch, which for a
 * `finding` is a duplicate, permanent GitHub comment (`answer-summary-
 * finding.ts` posts a new top-level comment on every call). A claim is what
 * makes only one of them allowed to dispatch.
 *
 * The claim is deliberately NOT stored in the JSON `held` array: it is a
 * filesystem-level mutex, so WINNING one never contends with `hold`/`park`/
 * `phase` for the per-PR lock — `claimCreate` below stays exactly as cheap as
 * an `O_CREAT|O_EXCL` write. Only the rare recovery paths (breaking a stale
 * claim, giving one back, confirming membership right after creating one) take
 * the lock.
 *
 * The claim is a single REGULAR FILE — not a directory with a nested owner
 * marker inside it. Three earlier prototypes used a two-step create — `mkdir`
 * to win the slot, then a SEPARATE write of an identity marker inside it —
 * and every one of them had the same window: between the `mkdir` and the
 * identity write, another claimant can legitimately remove-and-recreate the
 * directory at that same path (breaking what looked like a stale claim), so
 * the first claimant's identity write lands in a DIFFERENT generation of the
 * directory than the one it won, and both parties read a successful claim.
 * Reproduced empirically at every attempted variant (3/40, then 10/50 after a
 * naive verify-before-destroy fix, then ~20/150 after removing the destructive
 * restore). One atomic write closes it: 0/200 over the same probe.
 *
 * A key can be claimed only while it is IN the held batch, checked AFTER the
 * claim file is created, not before: checking first and creating second is a
 * check-then-act with a real gap, in which the item can leave the batch.
 * Ordering it the other way means the worst case is a claim created for a key
 * that has just left the batch — which the check immediately after catches,
 * the claim is released right back out, and the caller is told plainly there
 * is nothing to claim.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ExitError } from "../cli.ts";
import type { PathLock } from "./lock.ts";

const CLAIM_STALE_MIN_DEFAULT = 10;

/** Every claim file for one PR shares this prefix — the sweep uses it. */
export function claimPrefix(pr: string): string {
  return `drive-pr-${pr}.held-claim.`;
}

/**
 * `$DRIVE_PR_CLAIM_STALE_MIN`, validated rather than trusted. Two failure
 * directions, both silent:
 *   - a NEGATIVE or non-numeric value makes a claim reclaimable before its
 *     owner could plausibly finish dispatching, defeating the exclusivity the
 *     claim exists to provide.
 *   - an excessive value can wedge crash recovery for an arbitrary duration —
 *     an abandoned claim from a killed driver would then block every other
 *     driver from that key far longer than any legitimate dispatch runs.
 *
 * Clamped to [1, 1440] (1 minute .. 24h); anything that does not even parse as
 * a non-negative integer falls back to the default rather than being clamped,
 * since a typo'd value ("1O", "ten") is closer to "unset" than to "0". A
 * digits-only value can still be far outside any range arithmetic handles
 * exactly (`Number.parseInt('99999999999999999999')` is already past
 * `Number.MAX_SAFE_INTEGER`), so length alone rejects it before any comparison
 * sees it — 1440, the maximum, is four digits, and a wide margin above that is
 * already nonsensical input.
 */
export function claimStaleMin(): number {
  const raw =
    process.env.DRIVE_PR_CLAIM_STALE_MIN ?? `${CLAIM_STALE_MIN_DEFAULT}`;
  if (!/^[0-9]+$/.test(raw)) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN='${raw}' is not a non-negative integer — using the default (${CLAIM_STALE_MIN_DEFAULT}m) instead of letting it silently make every claim un-reclaimable.`,
    );
    return CLAIM_STALE_MIN_DEFAULT;
  }
  if (raw.length > 12) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN='${raw}' has too many digits to compare safely — using the default (${CLAIM_STALE_MIN_DEFAULT}m) instead of letting an out-of-range value bypass the clamp.`,
    );
    return CLAIM_STALE_MIN_DEFAULT;
  }
  const v = Number.parseInt(raw, 10);
  if (v < 1) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN=${v} is below the safe minimum (1m) — clamping to 1m. Any lower and a claim could be reclaimed before its owner finishes dispatching.`,
    );
    return 1;
  }
  if (v > 1440) {
    console.error(
      `drive-state.ts: DRIVE_PR_CLAIM_STALE_MIN=${v} exceeds the safe maximum (1440m/24h) — clamping to 1440m. Any higher and an abandoned claim could wedge recovery for longer than any legitimate dispatch would ever run.`,
    );
    return 1440;
  }
  return v;
}

/**
 * The RAW key, not the sanitised one, feeds the suffix. The sanitisation only
 * strips characters a path cannot carry, and both real key shapes already fit
 * inside that safe set (GitHub GraphQL thread ids are base64url;
 * `summary-findings.ts`'s fingerprints are validated against
 * MARKER_SAFE_FINGERPRINT, itself a subset). So the substitution alone is not
 * what gives two different keys two different paths — the filesystem is what
 * has to, and the state dir is not always case-sensitive: on a
 * case-insensitive volume (the default on macOS, where these worktrees run)
 * two thread ids differing only in the case of one character sanitise to the
 * SAME path. Measured against a real PR in this repo: 7 of 100 thread ids
 * collided that way. A colliding pair would then make one key's claim block,
 * or release, the OTHER key's — the digest suffix is keyed on the exact-case
 * original, so it, not the sanitised prefix, is load-bearing for uniqueness;
 * the prefix stays purely for readability when eyeballing the state directory.
 */
export function claimKeyForPath(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${safe}.${digest}`;
}

export function claimPathFor(
  stateDir: string,
  pr: string,
  key: string,
): string {
  return join(stateDir, `${claimPrefix(pr)}${claimKeyForPath(key)}`);
}

/**
 * The draft→Ready transition's claim — one per PR, no key, and deliberately
 * the SAME primitive as the held-batch claims above rather than a second
 * mechanism (`claimCreate`/`claimIsLive`/`breakStaleClaimLocked` all apply
 * unchanged, staleness window included).
 *
 * It is a LEASE, and that is the whole point of it being a file rather than a
 * field in the JSON. `readyMarkedRound` used to be the claim as well as the
 * record: set before `gh pr ready` and cleared on an ordinary failure. That
 * order is right against a second driver and wrong against a crash — a process
 * killed between the claim and the call left the field non-zero forever, so
 * every future invocation answered `already-marked` without ever looking at
 * GitHub, and the PR stayed a draft that nothing would ever mark. Splitting the
 * two makes each say only what it can prove: this file says "a driver is
 * attempting the transition right now", expires on its own if that driver dies,
 * and `readyMarkedRound` is written only AFTER `gh pr ready` returns success,
 * so a non-zero value there means the event genuinely fired.
 *
 * The name does not carry `claimPrefix`, so `claimFilesFor`'s held-batch sweep
 * never sees it — `release-held --all`'s contention check is about held items
 * and must not be blocked by an unrelated in-flight Ready transition.
 */
export function readyClaimPath(stateDir: string, pr: string): string {
  return join(stateDir, `drive-pr-${pr}.ready-claim`);
}

/**
 * A token unique enough that two calls never collide within one drive: the
 * calling PID plus fresh randomness. Nothing is created on disk here — this is
 * a name generator only, with no exclusivity claim of its own to race.
 */
export function newClaimToken(): string {
  return `${process.pid}-${randomBytes(3).toString("hex")}`;
}

/**
 * Atomically create `path` holding `token`, but ONLY if it does not already
 * exist — `wx` is `O_CREAT|O_EXCL`, one syscall. This is the ONE place a claim
 * is actually WON; everything else in this module only decides whether it is
 * safe to attempt one.
 */
export function claimCreate(path: string, token: string): boolean {
  try {
    writeFileSync(path, token, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff `path` is a LIVE claim file — exists and newer than the staleness
 * window. Staleness is the ONLY test, mirroring the per-PR lock's own
 * stale-lock check: a file `claimCreate` just made 0 seconds ago is
 * unconditionally live for the whole window, full stop, regardless of anything
 * else about it.
 */
export function claimIsLive(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs <= claimStaleMin() * 60_000;
  } catch {
    return false;
  }
}

/**
 * True iff `token` is non-empty and equals `path`'s current content — the
 * content check doubles as the ownership proof `release-held`/`unclaim-held`
 * need, and as the "did I actually keep the slot I created" check `claim-held`
 * runs on itself immediately before declaring victory. That final check is
 * still worth taking even though `claimCreate` is atomic: the claim can be
 * legitimately re-pointed at a NEW file between our own create and that later
 * read, and comparing content is what catches it rather than trusting a path
 * that still merely exists.
 */
export function claimTokenMatches(path: string, token: string): boolean {
  if (token === "") return false;
  try {
    return readFileSync(path, "utf8") === token;
  } catch {
    return false;
  }
}

/**
 * Remove a claim file — used both for a STALE claim being reclaimed and a live
 * one being released by its rightful owner. RENAME first (atomic; the loser of
 * any concurrent breaker removes nothing — the same technique the per-PR lock
 * uses to break itself), then delete the renamed copy. A missing file is not
 * an error: release/unclaim call this unconditionally as cleanup.
 */
export function removeClaimFile(path: string): void {
  const doomed = `${path}.released.${process.pid}`;
  try {
    renameSync(path, doomed);
    rmSync(doomed, { force: true });
  } catch {
    // the rename loser deletes nothing — exactly the point
  }
}

/**
 * Break a STALE claim file — under the PER-PR LOCK, which is what actually
 * closes this. Three earlier versions tried to approximate safety without a
 * true mutex — capture the target via a rename (atomic; the loser of any
 * single race removes nothing), re-verify staleness on the captured copy (an
 * unraceable read, since nothing but the capturer can name that path), and
 * either destroy it or put it back if it turned out live after all. Each fixed
 * the SPECIFIC interleaving that broke the version before it, and each was
 * reproducible again with a slightly different one: judging liveness by mtime
 * alone closed an identity race (~1/13 trials) but not two claimants each
 * independently capturing the SAME stale target (~3/40); verifying before
 * destroying, without restoring, left an evicted-but-live claim's slot empty
 * for anyone to walk into while the rightful owner was still mid-dispatch; and
 * adding the restore back fixed THAT but, under just TWO simultaneously-
 * stale-observing processes, still let 35-39 of 40 trials produce two winners
 * — because each straggler decides independently, against its OWN stale
 * snapshot, with no visibility into what the other is doing to the exact same
 * path at the exact same time. No amount of capture-then-verify closes that:
 * it is fundamentally a check-then-act with a real gap, and TWO checkers can
 * each pass through their own gap.
 *
 * There is no way to approximate a true mutex here — so use the one the state
 * store already has. Every other state mutation serialises through the per-PR
 * lock; wrapping the STALENESS DECISION and the REMOVAL in the same lock hold
 * makes "is it stale, and should I remove it" a single atomic question with a
 * single answerer at a time. Verified empirically: 0/100 on the harshest
 * reproduction that broke every earlier version.
 *
 * This does mean claiming a STALE key takes the per-PR lock, where every
 * earlier version deliberately avoided it. That is the right trade: a stale
 * claim is the crash-recovery path, not the hot path, and correctness there is
 * worth contending briefly with a `park` or `hold` that lands at the same
 * moment. The hot path — an uncontended or genuinely LIVE claim — never
 * touches the lock at all.
 *
 * `true` + the file removed means it was confirmed genuinely stale WHILE
 * HOLDING THE LOCK, so no other process can be deciding the same thing at the
 * same time — safe to `claimCreate` fresh afterwards (itself unlocked; losing
 * that specific race to a legitimate new claimant is the ordinary, expected
 * outcome, not a bug). `false` means the path was found live once the lock was
 * actually held (possibly because it only became live in the time it took to
 * acquire it), or the lock could not be acquired at all — treat both exactly
 * like an ordinary contended claim.
 */
/**
 * The staleness DECISION and the removal, for a caller that ALREADY holds the
 * per-PR lock. `tryBreakStaleClaim` below is exactly this plus the
 * acquisition — a caller inside `store.locked`/`store.update` MUST use this
 * one instead: the lock is not reentrant (`lock.ts`'s `acquire` retries its
 * own `mkdir` until it wins or times out), so calling `tryBreakStaleClaim`
 * from inside an already-locked section would spin to
 * `$DRIVE_PR_LOCK_TIMEOUT` and exit 1 rather than deadlocking visibly.
 */
export function breakStaleClaimLocked(path: string): boolean {
  if (claimIsLive(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export async function tryBreakStaleClaim(
  path: string,
  lock: PathLock,
): Promise<boolean> {
  try {
    await lock.acquire();
  } catch (e) {
    if (e instanceof ExitError) return false;
    throw e;
  }
  try {
    return breakStaleClaimLocked(path);
  } finally {
    lock.release();
  }
}

/** Every claim file currently on disk for this PR, live or leftover. */
export function claimFilesFor(stateDir: string, pr: string): string[] {
  const prefix = claimPrefix(pr);
  try {
    return readdirSync(stateDir)
      .filter((f) => f.startsWith(prefix))
      .map((f) => join(stateDir, f));
  } catch {
    return [];
  }
}

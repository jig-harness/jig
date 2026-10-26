/** Acquire and release generation-addressed driver locks without removing a successor claim. */
import {
  type ClaimDiag,
  CLAIM_PREFIX,
  parseClaimText,
  claimName,
  formatClaim,
  parseStagingHost,
  stagingLive,
  claimLive,
} from "./../claim.ts";

import { randomBytes } from "node:crypto";

import {
  readdirSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
  rmdirSync,
} from "node:fs";

import { join, dirname, basename } from "node:path";

import { hostname } from "node:os";

import { renameWithRetry } from "./../../../../../shared/rename-with-retry.ts";

import { errnoCode } from "./../../../../../shared/errors.ts";

import { isDigits, fail } from "./../cli.ts";

import { formatAccountIdentity } from "./../identity.ts";

import { stopRequestPath } from "./../stop-request.ts";

// ── Single-instance locking ─────────────────────────────────────────────────

/**
 * ONE driver per shared resource — and a drive has TWO of them, which is why
 * there are two locks rather than a debate about how to key one (each keying
 * is correct against the other's hazard):
 *
 *   - the WORKTREE. Two drivers in one worktree edit, commit and push the same
 *     working tree; one loop's round-agent committed and pushed the other
 *     session's in-progress edits (measured). They cross-ship whether or not
 *     they target the same PR, so this lock is keyed by worktree and carries
 *     the PR only as diagnostics.
 *   - the PR. Two drivers in DIFFERENT worktrees have separate working trees,
 *     so they never cross-ship edits — but they race pushes to one head
 *     branch and share the clone-wide durable state (`resolveStateDir()` is
 *     `--git-common-dir`, deliberately: round budgets and parked sets are
 *     per-clone). Conductor makes multi-worktree the normal case, so this
 *     lock is keyed by PR and lives clone-wide, next to the state it guards.
 *
 * Acquired in that fixed order, always, so two drivers contending for both can
 * never deadlock against each other.
 *
 * Staleness is keyed to the OWNER'S LIVENESS rather than to a fixed age window
 * (the state store's mutex, lib/state/lock.ts, does the latter — right for a
 * transaction, wrong for a lock held across a whole drive): a lock whose
 * recorded pid is dead is stale however young. A live pid is honoured only so
 * long as the owner keeps REFRESHING its claim, because a pid alone cannot
 * distinguish the driver from a stranger the OS handed its number to after it
 * died — see HEARTBEAT_STALE_MIN_DEFAULT.
 */
export interface DriveLock {
  dir: string;
  /** What it protects, for the refusal message. */
  what: string;
  /**
   * Written into the claim's diagnostics line at take time (`lib/claim.ts`) —
   * what an exit-11 refusal and the `drives.ts` listing can show about THIS
   * driver. Advisory: nothing that decides liveness or recovery reads it.
   */
  diag?: ClaimDiag;
  /**
   * This process's GENERATION of the lock, set when it is taken. It is not a
   * value later steps compare against a file's contents but the NAME of the
   * claim file this process published — which is what makes every later write
   * and removal address one INSTANCE rather than a path. A path names a SLOT,
   * and the slot's occupant can change between any two syscalls, which is
   * exactly how a check-then-act on the path alone hands two drivers the same
   * resource.
   */
  nonce?: string;
}

/** Unguessable, filesystem-safe, and unique per acquisition. */
function newNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * The one entry a lock instance publishes: `claim.<generation>`, whose format
 * — `<pid> <hostname>`, plus an optional operator-diagnostics line — lives in
 * `lib/claim.ts`, shared with the read-only listing (`drives.ts`)
 * so writer and reader cannot drift. Its mtime carries that instance's last
 * refresh; the hostname is what makes the pid check meaningful.
 *
 * The generation is in the NAME rather than in the contents, and that is the
 * whole design. Every destructive step of the protocol — a recoverer retiring
 * a stale instance, an owner releasing its own — names the entry it removes,
 * so an actor still acting on a generation that has since been replaced
 * removes a file that is already gone instead of the successor that took its
 * place. Suspension then needs no reasoning about at all, and nothing has to
 * be left behind as a fence.
 */
interface Claim {
  /** The entry name — the only handle anything is allowed to remove it by. */
  name: string;
  nonce: string;
  pid: number;
  host: string;
  platform: string | null;
  /** The claim's diagnostics line — advisory, absent on older claims. */
  diag: ClaimDiag | null;
}

/**
 * What occupies a lock path right now.
 *
 * `names` is the whole listing, not just the claim: it is the list a
 * retirement removes, and taking it from ONE `readdir` is what keeps that
 * removal addressed to entries this process actually saw. A lock's entries are
 * only ever installed wholesale by `takeLock`'s rename, so anything a
 * successor publishes is absent from an earlier observation by construction.
 */
interface Occupant {
  names: string[];
  /** Every `claim.*` seen. More than one is unreachable — see `acquire`. */
  claimNames: string[];
  claim: Claim | null;
  /**
   * True only when `readdirSync(dir)` itself threw — a transient permission,
   * I/O, or filesystem error, not a confirmed empty or occupied directory.
   * `claimNames` is `[]` in this case too, which is indistinguishable from a
   * genuinely vanished claim set unless a caller checks this flag first
   *: a directory read failure is not
   * evidence that a successor took over.
   */
  unreadable: boolean;
}

// Exported so the `unreadable` distinction is unit-testable on its own —
// same reasoning as `claimWasTakenOver`'s own export.
export function inspect(dir: string): Occupant {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { names: [], claimNames: [], claim: null, unreadable: true };
  }
  const claimNames = names.filter(
    (n) => n.startsWith(CLAIM_PREFIX) && n.length > CLAIM_PREFIX.length,
  );
  const only = claimNames.length === 1 ? (claimNames[0] as string) : null;
  const nothing = { names, claimNames, claim: null, unreadable: false };
  // Anything that is not exactly one claim is debris, and debris is retired by
  // name rather than trusted as an owner. Entries from a drive.ts older than
  // this one — a bare `pid`, a `heartbeat` — land here too, since backward
  // compatibility is deferred before general availability: this file owes
  // that old format nothing, not even a liveness check, and does not carry a
  // second parser to give it one (a liveness check for the legacy shape was
  // tried and reverted for exactly this reason).
  if (only === null) return nothing;
  try {
    const record = parseClaimText(readFileSync(join(dir, only), "utf8"));
    if (record === null) return nothing;
    return {
      names,
      claimNames,
      claim: {
        name: only,
        nonce: only.slice(CLAIM_PREFIX.length),
        pid: record.pid,
        host: record.host,
        platform: record.platform,
        diag: record.diag,
      },
      unreadable: false,
    };
  } catch {
    return nothing;
  }
}

/**
 * Does a directory that JUST held exactly our own claim now belong to
 * someone else, or to no one at all? True for coexistence (more than one
 * claim — a resurrected entry sitting ALONGSIDE ours), for a full
 * successor-only transition (exactly one claim, but not the one named
 * `ownClaimName`), and for a vanished claim set (zero claims observed) alike:
 * a contender that ran `retire()` after we renamed our rewrite over `dest`
 * removes exactly that file — `dest` never changes name across rewrites —
 * and rebuilds the directory from scratch with its OWN, differently-named
 * claim. Landing the inspection in the gap between that removal and the
 * successor's own rename reads zero claims, not one — `inspect()` also
 * folds a genuine `readdirSync` failure into the same empty result — and
 * either way this generation's own claim is not verifiably still there, so
 * both must read as loss exactly like the other two shapes. This function is
 * therefore true whenever `claimNames` is anything OTHER than the
 * single-element array containing exactly `ownClaimName`. Exported so this
 * decision is unit-testable on its own: the real race it detects is a
 * microsecond, unrepeatable window between a `renameSync` and the `inspect()`
 * call that follows it, with nothing in a single-process test able to land
 * inside it.
 */
export function claimWasTakenOver(
  claimNames: readonly string[],
  ownClaimName: string,
): boolean {
  return claimNames.length !== 1 || claimNames[0] !== ownClaimName;
}

/**
 * Publish the claim BEFORE the lock becomes visible. `mkdir` then write left a
 * window in which the lock existed with no record in it, indistinguishable
 * from an abandoned one; it was covered by an `mtime < 2000ms` wall-clock
 * guess, which is not a guess a shared or network-backed
 * `$DRIVE_PR_HANDOFF_DIR` honours. Staging +
 * `rename` removes the window instead of narrowing it.
 *
 * The mutual exclusion is `rename(2)`'s refusal to replace a NON-EMPTY
 * directory: the staging directory always carries a claim, so once any
 * instance is installed every later attempt fails. The ordinary destination is
 * ABSENT rather than merely empty — both `retire` and `release` `rmdir` the
 * slot once they have emptied it, which is what lets the rename succeed on
 * Windows too (`MoveFileEx` refuses an existing directory outright, empty or
 * not). Only the interleaving where a successor claimed the slot between that
 * `rmdir` and this rename still meets a non-empty directory, and that is
 * exactly the case the refusal is for. The read-back then settles which
 * contender landed, since the claim name is unguessable and this process is
 * the only one that ever wrote it.
 *
 * The staging directory's name carries pid AND host — host because the lock
 * directory itself may be shared across hosts (the same `$DRIVE_PR_HANDOFF_DIR`
 * concern the claim record's own host field exists for), and two hosts can
 * report the identical pid. Without host in the name, two such hosts compute
 * the identical staging path and each blindly `rmSync`s it as "my own leftover
 * from last time" on entry — destroying whatever the OTHER host had just
 * published there. Pid comes first and
 * host last so the name parses unambiguously despite a hostname that may
 * itself contain dots: pid is exactly the digits up to the first dot, host is
 * everything after it.
 *
 * This process's own staging is cleared on entry, but a crash between
 * creating it and renaming it is not bounded by that alone: nothing revisits
 * this exact pid+host's staging directory unless that exact, possibly-recycled
 * pid on that exact host happens to attempt this exact lock again, which on a
 * long-lived clone may never happen. `sweepStaleStaging` is what actually
 * bounds it — it inspects EVERY sibling staging directory, not just this
 * process's own, and reclaims the ones whose recorded owner is confirmed gone.
 */
function stagingDirFor(lock: DriveLock, pid: number, host: string): string {
  return `${lock.dir}.${pid}.${host}@${process.platform}.staging`;
}

function takeLock(lock: DriveLock): boolean {
  const nonce = newNonce();
  const staging = stagingDirFor(lock, process.pid, hostname());
  sweepStaleStaging(lock);
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(
      join(staging, claimName(nonce)),
      formatClaim(process.pid, hostname(), lock.diag),
    );
    renameWithRetry(staging, lock.dir);
  } catch (error) {
    console.error(
      `drive.ts: could not publish lock at ${lock.dir} (${errnoCode(error) ?? "unknown"}).`,
    );
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
  if (inspect(lock.dir).claim?.nonce !== nonce) return false;
  lock.nonce = nonce;
  return true;
}

/**
 * Parse the pid and host `stagingDirFor` encoded into a directory name, or
 * `null` if `entry` is not a staging directory for THIS lock at all.
 */
function parseStagingName(
  base: string,
  entry: string,
): { pid: number; host: string; platform: string | null } | null {
  const prefix = `${base}.`;
  const suffix = ".staging";
  if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) return null;
  const middle = entry.slice(prefix.length, entry.length - suffix.length);
  const dot = middle.indexOf(".");
  if (dot === -1) return null;
  const pidStr = middle.slice(0, dot);
  if (!isDigits(pidStr)) return null;
  return {
    pid: Number.parseInt(pidStr, 10),
    ...parseStagingHost(middle.slice(dot + 1)),
  };
}

/**
 * Reclaim staging directories orphaned by a crash before the `rename` that
 * installs them — the same "confirm the owner is gone" test a stale LOCK
 * recovers by, applied to staging because a crash there leaves an artifact
 * this process did not create and has no name of its own to find it by.
 *
 * The owner comes ONLY from the directory's own NAME — never from the claim
 * file inside it. An earlier cut preferred the claim file when readable,
 * reasoning that it was the more authoritative record; the opposite is true.
 * The directory becomes visible the instant `mkdirSync` returns, but the
 * claim file inside is written by a SEPARATE, non-atomic `writeFileSync`
 * afterward — so a sweep running concurrently with another host's own
 * publish can observe a torn write, e.g. `123 ` with no host token yet,
 * parsing as `host === ''`. `pidAlive` treats an empty host as "this host"
 * (the same convenient default it uses for genuinely old, host-less debris),
 * so a torn read from a FOREIGN host's in-flight publish gets probed
 * locally and can read as dead, and the recursive removal that follows then
 * destroys a directory that was never abandoned at all. The directory's NAME
 * carries no such window: it is fixed, complete, and correct from the single
 * atomic `mkdirSync` that creates it, never touched again — so it is the
 * only identity source this sweep should ever trust.
 *
 * `pidAlive` is necessary but not sufficient ON A HOST THIS PROCESS CAN
 * ACTUALLY PROBE: after the ORIGINAL publisher crashes, the OS can hand that
 * same pid to an unrelated long-lived process — the exact hazard
 * `HEARTBEAT_STALE_MIN_DEFAULT` documents for the main lock — and `pidAlive`
 * would then report that stranger as alive forever, since staging has
 * nothing to refresh. Unlike the main lock, staging cannot fall back to a
 * heartbeat: it is meant to exist for three synchronous syscalls, never
 * touched again, so `STAGING_STALE_MS` — far shorter than the lock's
 * multi-minute floor, but still generous by orders of magnitude over that
 * expected lifetime — is the fallback instead. Reclaiming a directory whose
 * pid merely reads as alive by age is still safe by the same argument as
 * everywhere else in this protocol: if that pid IS the true,
 * merely-suspended publisher, its own eventual `renameSync` just fails onto
 * an absent destination and `takeLock` reports failure the ordinary way —
 * never data loss, never two drivers.
 *
 * That safety argument depends on the age actually being comparable to THIS
 * host's clock, which is exactly what a foreign host's `pidAlive() === true`
 * is NOT evidence of — it is the fail-OPEN default for an unanswerable
 * question, not a confirmed liveness signal the age check may then
 * override. Applying the age fallback there anyway would delete a foreign
 * publisher's directory for being briefly slow, or for ordinary clock skew
 * on a shared mount — the exact class of guess `heartbeatStaleMs`'s own doc
 * rejects for the main lock. The loop below therefore restricts the age
 * fallback to entries on THIS host; a foreign host's entry is left alone
 * unconditionally, same as before this fallback existed.
 *
 * Every failure here is swallowed: this is opportunistic cleanup running
 * ahead of an acquire that must still succeed even if a sibling's directory
 * cannot be read or removed right now — it is not this attempt's job to force
 * that, only to leave it for a later sweep.
 *
 * The age policy itself — `STAGING_STALE_MS`, the foreign-host
 * `heartbeatStaleMs()` fallback, and the `pidAlive`-first ordering the
 * comments above justify — lives in `lib/claim.ts`'s `stagingLive`, shared
 * with `migrate-state-dir.ts`'s own staging-liveness check so the two never
 * drift into independently maintained copies of the same rule.
 */
function sweepStaleStaging(lock: DriveLock): void {
  const parent = dirname(lock.dir);
  const base = basename(lock.dir);
  const ownStaging = basename(stagingDirFor(lock, process.pid, hostname()));
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === ownStaging) continue; // this attempt's own — handled above
    const named = parseStagingName(base, entry);
    if (named === null) continue;
    const stagingDir = join(parent, entry);
    let age: number | null;
    try {
      age = Date.now() - statSync(stagingDir).mtimeMs;
    } catch {
      age = null; // gone, or unreadable — not this sweep's to force either way
    }
    if (stagingLive({ ...named, ageMs: age })) continue;
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // Leave it for a later sweep rather than fail THIS acquisition over a
      // sibling's directory this process may not even own.
    }
  }
}

/**
 * Age of the claim's last refresh, or `null` when it cannot be read — an
 * unreadable age must never be treated as a stale one.
 */
function lastRefreshAgeMs(dir: string, claim: Claim): number | null {
  try {
    return Date.now() - statSync(join(dir, claim.name)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Is the recorded owner alive? Delegated to `lib/claim.ts`'s `claimLive` —
 * one rule, shared with the operator listing, so `drives.ts` can never call
 * a claim live that recovery here would retire, or vice versa.
 */
function claimAlive(claim: Claim, dir: string): boolean {
  return claimLive({
    pid: claim.pid,
    host: claim.host,
    platform: claim.platform,
    ageMs: lastRefreshAgeMs(dir, claim),
  });
}

/**
 * Retire the instance that was OBSERVED, by removing exactly the entries that
 * observation listed.
 *
 * This is the step every earlier cut got wrong, and always in the same way: it
 * addressed the lock's PATH. Renaming the path to a per-pid destination let a
 * second contender that had observed the same stale owner move a live
 * replacement aside and drive alongside it; the same shape in `release` let a
 * suspended owner move its SUCCESSOR's lock and leave the canonical path
 * briefly empty for a third driver. Keying the rename's DESTINATION to the
 * observed generation closed both, because `rename(2)` refuses a non-empty
 * directory as a destination — but only for as long as that destination stayed
 * non-empty, which meant a tombstone per generation that nothing could ever
 * reclaim: two permanent directories per drive run, growing with lifetime
 * invocations. An age-based sweep of them is not available, and was tried and
 * reverted: the quantity a threshold would have to bound is "does any process
 * still hold an observation of generation N", which the filesystem cannot
 * answer.
 *
 * Naming the SOURCE instead needs no fence, and so leaves nothing to bound.
 * Every name here comes from one `readdir` of the lock, and a lock's entries
 * are only ever installed wholesale by `takeLock`'s rename — so an entry a
 * successor published cannot appear in an observation taken before it existed.
 * An actor still acting on generation N after N was replaced therefore removes
 * `claim.N`, which is already gone: a no-op, whatever occupies the path now,
 * however long that actor was suspended. The interleavings the tombstone
 * closed are closed by the addressing itself.
 *
 * The emptied directory is removed too, not merely left empty: POSIX `rename`
 * accepts an empty directory as a destination, but Windows' `MoveFileEx`
 * refuses to replace an existing directory at all, empty or not — and this
 * skill supports Windows (SKILL.md's runtime section). Left standing, an
 * emptied slot would make every recovery attempt fail there the same way,
 * forever. Removing it is safe by the
 * SAME identity argument `release` already uses for its own `rmdir`: it
 * refuses a directory that is not empty, so a successor that moved in between
 * this retirement's removals and this `rmdir` is what stops it — the failure
 * is swallowed, and the next `takeLock` attempt settles the race the normal
 * way, against a non-empty destination.
 */
function retire(dir: string, occupant: Occupant): void {
  for (const name of occupant.names) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  try {
    rmdirSync(dir);
  } catch {
    // A successor occupies it now, or removing it failed transiently — either
    // way not this retirement's to force; the caller's own takeLock retry is
    // what actually needs the slot, and it will find out for itself.
  }
}

/**
 * Acquire, recovering a lock whose owner is gone by RETIRING the instance that
 * was observed — see `retire` for why naming the instance rather than the path
 * is what makes a suspended contender harmless, and why nothing is kept back.
 *
 * Two contenders that observe the same stale generation both retire it, both
 * find the removal idempotent, and then race a `rename` that only one of them
 * can win; the loser refuses rather than driving. A contender whose
 * observation has been overtaken loses that race for the same reason, since
 * the winner's claim makes the destination non-empty.
 */
export function acquire(lock: DriveLock, pr: string): void {
  mkdirSync(dirname(lock.dir), { recursive: true });
  if (takeLock(lock)) return;

  const occupant = inspect(lock.dir);
  const held = occupant.claim;
  if (held !== null && claimAlive(held, lock.dir)) {
    // The diagnostics line answers what this refusal used to leave open —
    // WHICH PR that driver is working, from where, and where its log is. A
    // claim without one (an older driver) still names its owner, and the
    // drives.ts hint covers both.
    const about =
      held.diag === null
        ? []
        : [
            `That driver is working PR #${held.diag.pr} from ${held.diag.worktree}`,
            `(started ${held.diag.started}). Its log: ${held.diag.log}`,
            `Account: ${formatAccountIdentity(held.diag.account)}`,
          ];
    fail(
      11,
      `drive.ts: another driver already holds the ${lock.what} lock (pid ${held.pid} on ${held.host || "this host"}) — refusing to start a second loop.`,
      ...about,
      `Lock: ${lock.dir}. List live drives: drives.ts (same directory); stop one: drives.ts --stop <PR>.`,
      "If that loop is genuinely gone, remove the lock dir and retry.",
    );
  }
  if (occupant.claimNames.length > 1) {
    // Unreachable by construction — an instance is installed whole, by rename,
    // so a lock holds one generation or none. Refuse rather than guess which
    // of them to retire: the cost is a refusal a human clears in one command,
    // and the cost of guessing wrong is the two drivers this exists to prevent.
    fail(
      11,
      `drive.ts: the ${lock.what} lock holds ${occupant.claimNames.length} claims at once — refusing to guess which is live.`,
      `Lock: ${lock.dir}. Remove the lock dir once no driver is running.`,
    );
  }
  retire(lock.dir, occupant);
  if (held !== null) {
    console.error(
      `drive.ts: recovered a stale ${lock.what} lock (owner pid ${held.pid} is gone)`,
    );
  }
  if (!takeLock(lock)) {
    fail(
      11,
      `drive.ts: lost the ${lock.what} lock race for PR #${pr} — another driver recovered the same stale lock first.`,
    );
  }
}

/**
 * Release ONLY the instance this process took, and leave the slot free.
 *
 * There is no ownership check here, because there is nothing left to check:
 * the only entry this can remove is the one this process published, and a
 * successor's carries a different name. Release used to have a protocol of its
 * own — check the owner, then move the path to a private `.releasing.<nonce>`
 * name and inspect what actually arrived — and three different interleavings
 * went through it, all the same defect. A private destination is not a fence:
 * it is always free, so the rename always succeeds, so a process suspended
 * past the staleness window — its lock recovered, the path now holding a
 * SUCCESSOR's live lock — moves that successor's lock away and leaves the
 * canonical path momentarily absent for a third driver to claim.
 *
 * `rmdir` then reclaims the slot, and it is safe by the same argument taking a
 * different route: it refuses a directory that is not empty, so a successor
 * that has already moved in is what stops it. Identity again, not timing —
 * and, unlike the tombstone this replaces, it leaves nothing behind at all.
 */
export function release(lock: DriveLock): void {
  if (lock.nonce === undefined) return; // never taken
  rmSync(join(lock.dir, `processes.${lock.nonce}`), {
    recursive: true,
    force: true,
  });
  rmSync(stopRequestPath(lock.dir, lock.nonce), { force: true });
  rmSync(join(lock.dir, claimName(lock.nonce)), { force: true });
  try {
    rmdirSync(lock.dir);
  } catch {
    // A successor occupies it, or it is already gone. Either way it is not
    // this process's to remove.
  }
}

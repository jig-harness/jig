#!/usr/bin/env bun
/**
 * Reaper for drive-pr's own artifacts in `resolveStateDir`'s clone-wide
 * state directory — the default is `~/.local/state/groundwork/drive-pr/
 * <cloneKey>/`, not the legacy `--git-common-dir` this reaper
 * originally targeted; see the module docs below for why that relocation
 * happened and what it does and does not change here. Second category of
 * `tools/dev/reap-conductor-worktrees-cron.sh`'s weekly sweep, alongside
 * an earlier change's worktree reaper.
 *
 * ## What accumulates, and why nothing was removing it
 *
 * `lib/state/lock.ts` mints a PERMANENT quarantine directory every time a lock
 * generation is displaced — `${lock}.stale.<generation>` from `release`'s own
 * rename, `${lock}.recovering.stale.<generation>` from
 * `releaseRecoveringGate`'s. Both are happy-path output, not error recovery: a
 * single acquire/release cycle mints both, and every read-modify-write of
 * every PR's state goes through one. Measured on the machine this issue was
 * filed from: 112,281 quarantine directories in nine days (~337k inodes),
 * accelerating to ~35k/day, against a state dir that `lease.ts`, `claims.ts`
 * and `drives.ts` each `readdirSync` several times per drive round — 130-520ms
 * per enumeration by the end.
 *
 * an earlier change already shipped the safe half of the answer: `sweepLockQuarantine`
 * COMPACTS a quarantine directory to a single empty file at the same path,
 * preserving the fence (a `rename(2)` onto a non-directory fails) while
 * collapsing it to a single inode. What it never got was a caller — its
 * production call site was `drive-state.ts`'s `reset`, which nobody runs
 * on the normal path, so every one of those 112k entries was still an
 * uncompacted directory. This script is that caller.
 *
 * ## Why this is not the TTL sweep an earlier change forbids
 *
 * an earlier change is explicit: *"Do not implement a naive TTL/age-based cleanup for
 * this"* — wall-clock age alone cannot prove no in-flight observer still holds
 * a reference to a given lock generation, and a sweep built on it trades a
 * storage leak for the reintroduced TOCTOU that the whole quarantine scheme
 * exists to close. The distinct operations below, and only one of them
 * removes anything:
 *
 *   COMPACT — applied to every `createLock` anchor still in use. Needs no
 *     precondition at all (`sweepLockQuarantine`'s own doc comment, and
 *     `drive-state.ts`'s call site: *"`reset` is simply a convenient,
 *     low-traffic place to trigger it, not a safety requirement for it"*).
 *     The fence survives; only the inodes go.
 *
 *   RETIRE — deletes a whole per-PR or per-worktree family outright, and is
 *     gated on the LIFECYCLE predicate an earlier change itself prescribes: *"Once a
 *     PR's own state is being retired … it is safe to delete all of that PR's
 *     quarantine directories at once, in bulk — because no future observer can
 *     ever reference that PR's lock generations again."* The age gate below is
 *     an ADDITIONAL conservative guard stacked on top of that predicate, never
 *     a substitute for it. Drop the lifecycle checks and keep only the age and
 *     this becomes exactly the sweep an earlier change rules out.
 *
 * Every gate fails CLOSED. A `gh` call that errors, a lease file that cannot be
 * parsed, a `stat` that throws — each leaves the family untouched and reported,
 * because the cost of retiring one family too early (a live driver's state
 * deleted out from under it) is unbounded and the cost of retiring it a week
 * late is one more weekly run.
 *
 * RETIRE takes the whole family, including `drive-pr-<pr>.json` itself, not
 * just the quarantine around it. an earlier change phrased its direction as a sweep
 * piggybacking on whatever already retires a PR's state; nothing did, so this
 * is what retires it. The thing that makes that safe is the same thing that
 * makes deleting the quarantine safe, and it is worth naming because the state
 * file is where a PARKED HUMAN DECISION lives — losing one is the failure this
 * whole subsystem is built around. A MERGED PR cannot be driven forward again
 * — `lib/status/evaluate.ts` reports `PR_NOT_OPEN`, which is terminal
 * (`references/terminal-states.md`), so a driver aimed at one stops instead of
 * resuming from this state. Add to that: no lease has been live on it, and
 * nothing in the family has been touched for a week. There is no decision
 * left in there for anyone to act on. Nothing weaker than all of those
 * together would do. A CLOSED-but-unmerged PR does NOT qualify — GitHub lets
 * it be reopened with no time limit, `PR_NOT_OPEN` is only terminal for the
 * CURRENT pass rather than proof nothing will ever resume it, and the family
 * is kept indefinitely (compacted, never retired) instead.
 *
 * ## What it deliberately does not touch
 *
 * `pr-drive-<pr>.lock` and `pr-drive-worktree-<key>.lock` are `drive.ts`'s own
 * single-instance locks, and they are NOT `createLock` anchors — they use the
 * source-named claim protocol an earlier change moved to precisely so that nothing
 * accumulates and nothing needs sweeping (the claim's filename IS the identity,
 * so retiring it removes an entry by name). Compacting them would be
 * meaningless and deleting them is their own protocol's business, so they are
 * classified, reported, and left alone. Same for every entry that does not
 * match a known shape: git's own files, the skill-suite stamp stores,
 * `worktrees/`. An unrecognised name is never a deletion candidate — this
 * script only ever removes entries it can name the owner of.
 *
 * ## Cost
 *
 * Every predicate this reuses — `liveLeasesFor`, `unreadableLeaseFilesFor`,
 * `sweepLockQuarantine` — re-enumerates the whole state dir on each call, and
 * none of them is forked into a faster copy that takes a pre-read name list:
 * they are the most consequential judgements in this sweep, and a second
 * implementation of any of them is a second thing that can drift from the
 * safety argument written beside it.
 *
 * What IS avoided is calling them when they provably have nothing to do.
 * Unconditional compaction is O(anchors × entries) — measured at 9.8s for 40
 * anchors over 20k entries, extrapolating to ~12 minutes for the 508 anchors
 * over 113k entries above. And it would not decay: compaction shrinks inodes,
 * not the ENTRY count that drives the enumeration, so that cost would recur
 * every week. `anchorsWithUncompactedWork` reduces the steady state to one
 * `readdir` plus one `stat` per quarantine entry. The first run pays the full
 * price once; later runs pay it only for what has been minted since.
 *
 * Retirement still costs `judgePrFamily`'s own `liveLeasesFor` and
 * `unreadableLeaseFilesFor` enumerations per merged-PR candidate, which is
 * the population that shrinks on its own as families retire.
 *
 * ## Growth-rate reporting
 *
 * `--delete` persists a `.reap-state-snapshot.json` in the state dir — this
 * run's entry count, taken AFTER whatever RETIRE removed (compaction never
 * changes the top-level count, so it contributes no correction) — and the
 * NEXT run reports `growthPerDay` as the delta between that prior
 * post-cleanup count and its own pre-cleanup count, normalised to entries
 * per day. This is deliberately NOT a mechanism that removes anything on its
 * own; it exists so a regression in the generation rate this script cannot
 * itself bound (RETIRE's PR-merged + idle-7-days gate leaves an actively-
 * driven PR's own quarantine growing without limit — an earlier change's accepted,
 * deliberate tradeoff, see above) surfaces as a number in every run's report
 * instead of requiring a human to diff two `entries` fields by hand days
 * apart. A real fix for the underlying growth needs the kind of core-
 * mechanism redesign an earlier change already tracks as deferred work; this is
 * observability, not a mitigation.
 *
 * Usage:
 *   bun <skill-dir>/scripts/reap-state.ts            # dry run (default)
 *   bun <skill-dir>/scripts/reap-state.ts --delete   # act
 *   bun <skill-dir>/scripts/reap-state.ts --json     # machine-readable report
 *
 * Flags:
 *   --delete            Actually compact and retire. Without it, nothing on
 *                       disk changes and the report says what would happen.
 *   --min-age-days N    Extra idle guard on RETIRE only (default 7, min 1).
 *                       Compaction ignores it — it has no precondition.
 *   --json              Emit the report as JSON instead of prose.
 *
 * Exit codes: 0 = ran to completion (including "nothing to do"), 1 = the
 * state dir could not be enumerated, a removal or compaction did not
 * actually complete, (with `--delete`) a concurrent `--delete` run already
 * held the exclusive lock and this one refused to race it, or the growth-rate
 * snapshot failed to persist, 2 = bad arguments.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import { ghCall, git, gitCallTimeoutSeconds } from "./lib/proc.ts";
import {
  anchorOf,
  COMPACTING_STAGING_RE,
  classify,
  type Family,
  isLegacyMigrationMarker,
  isReaperArtifact,
  REAPER_SNAPSHOT_FILENAME,
} from "./lib/state/artifacts.ts";
import { atomicWrite } from "./lib/state/fsutil.ts";
import {
  liveLeasesFor,
  liveTreeLeaseFor,
  treeLeaseUnreadableAndFreshFor,
  unreadableLeaseFilesFor,
} from "./lib/state/lease.ts";
import {
  createLock,
  lockHeartbeatMs,
  type PathLock,
  sweepLockQuarantine,
} from "./lib/state/lock.ts";
import {
  defaultStateDirFor,
  peekDefaultStateDirFor,
  peekResolvedStateDir,
  resolveLegacyStateDir,
  resolveStateDir,
} from "./lib/state/store.ts";

/** Default extra idle guard on RETIRE, in days. */
const DEFAULT_MIN_AGE_DAYS = 7;

/**
 * Same bound `reap-conductor-worktrees-cron.sh` enforces on
 * `REAP_CRON_MIN_AGE_DAYS` before forwarding it — enforced here too so a
 * direct invocation (the documented bridge for reclaiming a backlog sooner)
 * gets the identical protection, not just the wrapper's env-var path.
 */
const MAX_MIN_AGE_DAYS = 365;

/**
 * Entry count at which this script stops merely REPORTING the number and
 * starts calling it a problem.
 *
 * The count, not the inode count, is what every consumer pays: `lease.ts`,
 * `claims.ts` and `drives.ts` each `readdir` this directory several times per
 * drive round, and anything else watching the tree (a JetBrains VFS refresh,
 * a backup agent) enumerates it too. Compaction cannot bring it down — it
 * collapses a quarantine directory to a single empty file AT THE SAME PATH,
 * so the entry survives — and RETIRE only fires on the lifecycle predicate,
 * which a `drive-tree-lease-wt-*` family whose worktree still exists never
 * satisfies. So on a clone with many long-lived worktrees this number grows
 * without bound even when this reaper runs correctly every week, and no
 * amount of sweeping is the answer — only an earlier change's relocation out of
 * `--git-common-dir` (the default since then) contains the blast radius, by
 * moving the growth out of the directory every git-aware tool on the machine
 * walks. It does not stop the growth itself: a clone already on that default
 * hitting this threshold has the same unbounded count, just in a location
 * fewer tools watch.
 *
 * Set below the range where that has actually hurt rather than at it:
 * an earlier change measured 130-520ms per enumeration at 112k entries, and one clone
 * reached 382,524 entries, where a single `readdir` cost ~10s and held an IDE
 * permanently in "File System Synchronization". Warning at 50k puts the line
 * comfortably before the first of those, so the weekly log says so while the
 * remedy is still cheap.
 */
const ENTRY_COUNT_WARN_THRESHOLD = 50_000;

/**
 * The entry-count WARNING for a sweep that found `entries`, or `null` when the
 * directory is still a healthy size.
 *
 * A WARNING, never a nonzero exit: the sweep itself succeeded, and the remedy
 * is a machine-configuration change — confirming the migration ran
 * (see the drive-pr skill's "State directory"), or a further
 * `$DRIVE_PR_STATE_DIR` relocation if even that default is being walked by
 * something that cannot afford it — that no sweep can make for itself.
 * Failing the run would turn a condition the
 * operator has to act on into a cron job that merely looks broken, which is
 * how the previous version of this went unnoticed — the count was printed
 * every week, at 164k, then 233k, then 382,524, and never once read as
 * different from a healthy run.
 *
 * `alreadyRelocated` is whether the resolved `stateDir` is
 * demonstrably neither the legacy `--git-common-dir` location nor the
 * ordinary an earlier change default — never derived from `$DRIVE_PR_STATE_DIR`'s
 * mere presence, which `drive.ts` sets unconditionally even when it resolved
 * to the plain default (see the call site). Without this, this warning told
 * an operator who had already relocated to relocate again — an impossible
 * remedy, since relocating
 * further changes WHICH tool pays the `readdir` cost, never the entry count
 * itself: `lease.ts`, `claims.ts` and `drives.ts` enumerate the SAME entries
 * wherever the directory lives, and RETIRE only shrinks the count once a
 * `drive-tree-lease-wt-*` family's own worktree is actually gone.
 *
 * Split out from `main` so the threshold is testable without materialising
 * 50,000 directory entries.
 */

/**
 * Whether `stateDir` is a genuine `$DRIVE_PR_STATE_DIR` relocation — never
 * derived from the env var's mere presence (docomply-review,
 * chatgpt-codex-connector, a reference-implementation pull request round 2). Two ways that presence lies:
 * `drive.ts` unconditionally re-exports its OWN resolved `stateDir` under
 * this name, including when `resolveStateDir` picked the ordinary
 * an earlier change default — so every drive-spawned child sees the variable "set"
 * whether or not an operator ever configured a real override. And a
 * genuinely-set override can still point AT the legacy `--git-common-dir`
 * location `store.ts` already recognizes, which is not a relocation at all.
 *
 * Comparing the RESOLVED `stateDir` against both non-relocated locations
 * sidesteps the env var entirely: it reads the same whether an override is
 * absent, present but redundant with the default, or present but pointed at
 * the legacy dir — `true` only when `stateDir` is demonstrably neither.
 * `computedDefault === null` (no persisted clone identity to preview) can
 * only occur here when `stateDir` came from a real override — the no-override
 * path resolves to `legacyDir` itself in that case (`peekStateDir`'s own
 * fallback), which the first comparison already excludes — so `!==` against
 * `null` is exactly the right answer, not a case needing its own branch.
 *
 * Equality with `legacyDir` alone is not enough: an override placed BENEATH
 * it — `/repo/.git/drive-pr-state`, say — is neither equal to `legacyDir`
 * nor to `computedDefault`, so a bare `!==` reads it as a genuine relocation
 * even though the growing entry population is still inside `.git`, the
 * exact IDE/backup/git-metadata blast radius an earlier change exists to escape
 * (chatgpt-codex-connector, a reference-implementation pull request round 8). `isDescendantOf` checks
 * ancestry, not just identity — and the SAME hazard applies to
 * `computedDefault`: an override nested beneath the ordinary an earlier change
 * default (`~/.local/state/groundwork/drive-pr/<clone>/custom`) still sits under the tree
 * an IDE or backup tool watching `~/.local/state/groundwork` already pays the recursive-
 * enumeration cost for, so it is not a genuine relocation either
 * (chatgpt-codex-connector, a reference-implementation pull request round 8, a fresh finding on the same
 * push).
 */
export function computeAlreadyRelocated(
  stateDir: string,
  legacyDir: string,
  computedDefault: string | null,
): boolean {
  return (
    stateDir !== legacyDir &&
    !isDescendantOf(stateDir, legacyDir) &&
    stateDir !== computedDefault &&
    (computedDefault === null || !isDescendantOf(stateDir, computedDefault))
  );
}

/**
 * Whether `child` is `parent` itself's descendant — inside it, at any
 * depth — using path ancestry rather than a string-prefix check: a bare
 * `child.startsWith(parent)` would also match an unrelated SIBLING whose
 * name happens to extend `parent`'s (`/repo/.gitignore` for `parent =
 * '/repo/.git'`). `relative()` resolving to something that does not escape
 * upward (no leading `..`) and is not itself absolute is the standard way
 * to ask "is B under A" without that false positive.
 */
function isDescendantOf(child: string, parent: string): boolean {
  if (child === parent) return false;
  const rel = relative(parent, child);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

/**
 * `realpathSync`, tolerating a path that does not exist (or is not
 * traversable) rather than throwing — `computedDefault` in particular may
 * name a directory nothing has created yet. Falls back to the ORIGINAL,
 * unresolved path on any failure, which keeps `computeAlreadyRelocated`'s
 * comparison at least as correct as the pre-symlink-aware version rather
 * than failing the whole advisory computation over one unreadable path.
 */
export function resolveRealPathBestEffort(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * `computeAlreadyRelocated`'s inputs, resolved for the CURRENT run.
 * `resolveLegacyStateDir` spawns `git rev-parse --git-common-dir`, which
 * can fail even when `stateDir` was already resolved successfully via an
 * override set outside any git repository — this suite's own git-failure
 * fixtures exercise exactly that combination for unrelated reasons, and a
 * git call this section adds for an ADVISORY wording must not take the
 * whole report down with it. Best-effort: any failure degrades to `false`,
 * the same answer a genuinely fresh, never-relocated clone gets — the worse
 * case is a redundant "you could relocate further" hint to an operator who
 * already did, not a crash.
 *
 * Each path is resolved to its filesystem identity (`realpathSync`, best
 * effort) before the lexical comparison in `computeAlreadyRelocated`: a
 * `$DRIVE_PR_STATE_DIR` override that is an absolute SYMLINK pointing back at
 * the legacy `--git-common-dir` or the ordinary an earlier change default is still
 * the SAME physical directory, and a bare string comparison would read it as
 * a genuine relocation, suppressing the remedy for an operator who never
 * actually escaped either location (docomply-review, a reference-implementation pull request round 5). The
 * pure `computeAlreadyRelocated` itself stays lexical and synchronous —
 * exactly what makes it unit-testable with synthetic, non-existent paths —
 * so the filesystem-identity resolution belongs at this impure boundary,
 * not inside it.
 *
 * `resolveLegacyStateDir` failing is not automatically the "not a git
 * repo, so `stateDir` must have come from an override" case an earlier
 * revision inferred from its thrown `ExitError(2)` alone: that function
 * collapses EVERY nonzero `git rev-parse --git-common-dir` result into the
 * identical generic failure, including `run`'s own deadline-kill (its
 * `code: 124`) on a transient stall — a case that proves nothing about
 * `stateDir`'s origin (chatgpt-codex-connector, a reference-implementation pull request round 8).
 * `mightBeMissingGitRepo` below runs its OWN independent, bounded git call
 * and reads `RunResult.timedOut` and `stderr` directly, so a deadline-kill
 * and a genuine "fatal: not a git repository" are never conflated — only
 * the latter licenses `true`.
 */
async function mightBeMissingGitRepo(): Promise<boolean> {
  try {
    const r = await git(["rev-parse", "--git-common-dir"], {
      stderr: "pipe",
      timeoutSec: gitCallTimeoutSeconds(),
    });
    if (r.code === 0 || r.timedOut) return false;
    return /not a git repository/i.test(r.stderr);
  } catch {
    return false;
  }
}

async function computeAlreadyRelocatedForStateDir(
  stateDir: string,
  del: boolean,
): Promise<boolean> {
  let legacyDir: string;
  try {
    legacyDir = await resolveLegacyStateDir();
  } catch {
    return mightBeMissingGitRepo();
  }
  try {
    const computedDefault = del
      ? defaultStateDirFor(legacyDir)
      : peekDefaultStateDirFor(legacyDir);
    return computeAlreadyRelocated(
      resolveRealPathBestEffort(stateDir),
      resolveRealPathBestEffort(legacyDir),
      computedDefault === null
        ? null
        : resolveRealPathBestEffort(computedDefault),
    );
  } catch {
    return false;
  }
}

export function entryCountWarningFor(
  entries: number,
  alreadyRelocated: boolean,
): string | null {
  if (entries < ENTRY_COUNT_WARN_THRESHOLD) return null;
  const remedy = alreadyRelocated
    ? "This IS the `$DRIVE_PR_STATE_DIR` relocation already — there is no " +
      "further relocation that lowers the cost, since every consumer " +
      'readdirs however many entries live here regardless of where "here" ' +
      "is. RETIRE still shrinks the count for whatever this run's own " +
      "census classifies as retirable (a merged or closed PR's own " +
      "family), so a `--delete` run remains worth checking — the ONE " +
      "family it can never clear on its own is `drive-tree-lease-wt-*` for " +
      "a worktree that still exists, which only shrinks once that " +
      "worktree is actually torn down. Sweeping harder (a smaller " +
      "`--min-age-days`) will not help either way."
    : "If this clone has not yet run the migration (see the " +
      'drive-pr skill, "State directory"), that is the first fix — moving ' +
      "the growth out of `--git-common-dir`. Already migrated and still " +
      "hurting? Relocate further with $DRIVE_PR_STATE_DIR (see the " +
      'drive-pr skill, "Relocating the state dir") rather than sweeping ' +
      "harder.";
  return (
    `state dir holds ${entries} entries (at or above ${ENTRY_COUNT_WARN_THRESHOLD}). ` +
    "Compaction cannot reduce this, and RETIRE never fires for the tree-lease " +
    "family of a worktree that still exists, so it will keep growing; every " +
    `consumer readdirs this directory several times per drive round. ${remedy}`
  );
}

/**
 * How many PRs' GitHub state to resolve at once.
 *
 * One `gh pr view` per PR rather than a single `gh pr list`: the population is
 * every PR this clone has ever driven (191 when an earlier change was measured), which
 * spans far more than any one `--limit` page and includes numbers that may no
 * longer exist at all. Bounded concurrency keeps a weekly run to seconds
 * without opening 191 sockets at once.
 */
const GH_CONCURRENCY = 6;

/**
 * The exclusive delete-run lock's anchor — the same `file` argument
 * `createLock` (below) is pointed at, before it appends its own `.lock`
 * suffix. See `deleteLock`'s doc comment for what it guards.
 */
const DELETE_LOCK_ANCHOR = ".reap-state-delete";

/**
 * `isReaperArtifact` (this script's own bookkeeping — its snapshot file and
 * its delete-run lock's whole family) plus `legacy-state.ts`'s migration
 * marker (`isLegacyMigrationMarker`) — not this script's own bookkeeping, but
 * permanently present in every migrated default state directory and equally
 * not backlog. Without this, `classify` reported it as `unrecognised` on
 * every single healthy migrated clone, weakening the anomaly signal the
 * reaper exists to expose (chatgpt-codex-connector, a reference-implementation pull request round 13).
 */
function isReapOwnArtifact(name: string): boolean {
  return isReaperArtifact(name) || isLegacyMigrationMarker(name);
}

/**
 * Every live worktree's actor key — `sha256(toplevel).slice(0, 16)`, the exact
 * derivation `lib/state/actor.ts`'s `worktreeKey` uses.
 *
 * A tree lease whose key is absent from this set is the PRIMARY signal that
 * its directory is gone — but not an exact one on its own: `git worktree
 * list`'s registration can be pruned or lost by a git operation elsewhere
 * while the checkout, and a process still holding the lease, remain
 * (docomply-review, a reference-implementation pull request). `judgeActorFamily`'s `liveTreeLeaseFor` veto is
 * what closes that gap; this set alone is a strong but not exact predicate.
 * Re-derived here rather than imported because `worktreeKey` deliberately
 * answers only for the CURRENT process's tree and accepts no override — the
 * identity it exists to protect must not be settable (see its own doc
 * comment) — while this needs the key of every OTHER tree.
 *
 * Returns `null` when git could not be asked, which fails the whole per-actor
 * predicate closed: an empty set would read as "no tree exists" and retire
 * every lease on the machine.
 */
async function liveWorktreeKeys(): Promise<Set<string> | null> {
  // `-z` (NUL-terminated fields, per `git worktree list -h`) rather than the
  // default newline-terminated form: a worktree path containing an embedded
  // newline — legal on POSIX filesystems — would otherwise split across two
  // lines here, hashing only a FRAGMENT of the path and never matching
  // `worktreeKey()`'s hash of the whole thing, misjudging a still-live
  // worktree as absent and its tree lease as retirable (chatgpt-codex-
  // connector, PR #4197 round 12).
  const r = await git(["worktree", "list", "--porcelain", "-z"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (r.code !== 0) return null;
  const keys = new Set<string>();
  for (const line of r.stdout.split("\0")) {
    if (!line.startsWith("worktree ")) continue;
    // Trimmed to match `worktreeRoot()`'s OWN derivation (`lib/state/actor.ts`
    // — `r.stdout.trim()` on `git rev-parse --show-toplevel`), which is the
    // canonical definition `worktreeKey()` hashes against. Whatever that
    // derivation does is what THIS one has to replicate exactly — not what
    // is separately "more correct" for an isolated path string — or the two
    // hashes diverge for a path ending in whitespace (a trailing newline in
    // particular) and a still-live worktree's tree lease reads as belonging
    // to a deleted one (chatgpt-codex-connector, a reference-implementation pull request round 14; round
    // 12's own NUL-delimiting fix dropped this trim without checking that it
    // was needed for parity, not just for its own sake).
    const path = line.slice("worktree ".length).trim();
    if (path === "") continue;
    keys.add(
      `wt-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
    );
  }
  // A repository always has at least one worktree, so an EMPTY set means the
  // porcelain output was not what this parser expects — same fail-closed
  // ruling as a nonzero exit, for the same reason.
  return keys.size === 0 ? null : keys;
}

type PrLifecycle = "open" | "retired" | "closed" | "unknown";

/**
 * PR `pr`'s lifecycle, for the retirement predicate below to act on — open,
 * merged/gone (`retired` — see that value's own note), closed-but-unmerged
 * (its own `closed` value, deliberately NOT "done with"), or unknown.
 *
 * `unknown` on any answer this cannot interpret (network failure, auth
 * failure, an unrecognised state string), and `unknown` never retires
 * anything. A PR that 404s IS retired: the state can only have been created by
 * a drive against a PR that existed, so a number GitHub no longer knows about
 * cannot come back.
 *
 * `CLOSED` is deliberately its OWN answer, not folded into `retired`
 * (docomply-review, a reference-implementation pull request): GitHub permits reopening a closed PR
 * indefinitely, with no time limit, and `drive-status.ts` explicitly accounts
 * for that ("a closed PR may be REOPENED"). `retired`'s whole safety argument
 * — "no future observer can ever reference that PR's lock generations again"
 * — does not hold for it, unlike `MERGED`, which GitHub never lets
 * come back. `judgePrFamily` treats it as keep-forever, not retire-when-idle.
 */
async function prLifecycle(pr: string): Promise<PrLifecycle> {
  const r = await ghCall(["pr", "view", pr, "--json", "state"], {
    stderr: "pipe",
  });
  if (r.code !== 0) {
    // `gh` exits nonzero for "no pull requests found" and for a transport,
    // auth, or repository-resolution failure alike, so the message is the
    // only thing that separates a definitively-gone PR from an inconclusive
    // answer. The GraphQL 404 shape for a genuinely nonexistent PR NUMBER is
    // "Could not resolve to a PullRequest with the number of N" — matched
    // narrowly on "PullRequest" so this cannot also match "Could not resolve
    // to a Repository with the name '…'" (a scheduled job that has
    // temporarily lost repo access, `gh api` measured) or "Could not resolve
    // host: github.com" (DNS/transport), either of which would otherwise
    // misclassify every queried PR as `retired` and permit deleting families
    // whose lifecycle was never actually checked.
    return /no pull requests found|could not resolve to a pull\s*request/i.test(
      `${r.stderr}`,
    )
      ? "retired"
      : "unknown";
  }
  let state: unknown;
  try {
    state = (JSON.parse(r.stdout) as { state?: unknown }).state;
  } catch {
    return "unknown";
  }
  if (state === "MERGED") return "retired";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return "open";
  return "unknown";
}

/** Resolve every PR's lifecycle with bounded concurrency. */
async function prLifecycles(prs: string[]): Promise<Map<string, PrLifecycle>> {
  const out = new Map<string, PrLifecycle>();
  const queue = [...prs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const pr = queue.shift();
      if (pr === undefined) return;
      out.set(pr, await prLifecycle(pr));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GH_CONCURRENCY, queue.length) }, worker),
  );
  return out;
}

/**
 * Newest mtime across a family, or `null` if any member could not be stat'ed.
 *
 * `null` fails the age gate closed. An entry that cannot be stat'ed is one this
 * script cannot prove is idle, and a family is only ever retired WHOLE — so a
 * single unreadable member has to veto the whole group rather than be skipped.
 */
function newestMtimeMs(
  stateDir: string,
  names: readonly string[],
): number | null {
  let newest = 0;
  for (const n of names) {
    try {
      newest = Math.max(newest, statSync(join(stateDir, n)).mtimeMs);
    } catch {
      return null;
    }
  }
  return newest;
}

/**
 * Names that `sweepLockQuarantine` would actually DO something to: a
 * generation-keyed quarantine entry, or a `.compacting.*` staging leftover
 * from a killed earlier pass.
 *
 * Deliberately NOT the live `<anchor>.lock` / `<anchor>.lock.recovering`
 * paths, which are directories too. Those stay owned by `createLock`'s own
 * acquire/release protocol and the sweep leaves them alone — counting them
 * here would mark every anchor as needing work forever, which is exactly the
 * cost this filter exists to avoid.
 */
function isSweepable(name: string): boolean {
  return (
    name.startsWith(".compacting.") ||
    /\.lock(\.recovering)?\.stale\./.test(name)
  );
}

/**
 * The subset of a family's anchors that still has uncompacted work.
 *
 * `sweepLockQuarantine` re-enumerates the whole state dir on every call, so
 * calling it once per anchor unconditionally is O(anchors × entries): measured
 * at 9.8s for 40 anchors over 20k entries, which extrapolates to ~12 minutes
 * for the 508 anchors over 113k entries an earlier change was filed against — every
 * week, since compaction shrinks inodes but not the ENTRY count that drives
 * the enumeration. Skipping anchors whose quarantine is already compacted
 * turns the steady state into one `readdir` plus one `stat` per quarantine
 * entry, and the first run is the only one that pays the full price.
 *
 * A `stat` that throws counts AS work: it means this cannot prove there is
 * nothing to do, and the honest response is to let the audited sweep look for
 * itself rather than skip on an unreadable answer.
 *
 * Racy by construction, and harmlessly so: a driver can mint a fresh
 * quarantine between this scan and the sweep. Compaction is an optimisation,
 * not a correctness requirement — anything missed is picked up next week.
 */
function anchorsWithUncompactedWork(
  stateDir: string,
  family: Family,
): Set<string> {
  const todo = new Set<string>();
  for (const name of family.names) {
    if (!isSweepable(name)) continue;
    const anchor = anchorOf(name);
    if (anchor === null || !family.anchors.has(anchor)) continue;
    if (todo.has(anchor)) continue;
    try {
      if (statSync(join(stateDir, name)).isDirectory()) todo.add(anchor);
    } catch {
      todo.add(anchor);
    }
  }
  return todo;
}

/**
 * Re-verifies, right after `sweepLockQuarantine` runs, that `anchor`'s
 * quarantine entries actually compacted.
 *
 * `sweepLockQuarantine` (and `compactQuarantineEntry` beneath it) is `void`
 * by design, and every internal write failure inside it is swallowed — a
 * read-only state dir, EACCES, or ENOSPC all fall through to a best-effort
 * fence-restore fallback with no signal back to the caller (`lock.ts`'s own
 * doc comment on that fallback). Without this, a compaction that genuinely
 * did nothing on such a filesystem still leaves `compacted` incremented and
 * `failures` empty, so the scheduled reaper exits 0 and logs `RESULT: OK`
 * while the backlog it was supposed to shrink stays exactly as large
 * (docomply-review, a reference-implementation pull request round 9). Reruns the SAME per-name check
 * `anchorsWithUncompactedWork` uses, scoped to just this one anchor's
 * entries rather than a full re-scan of the state dir.
 *
 * A `.compacting.*` staging leftover is the ONE `isSweepable` shape this
 * inverts the polarity for. Every other shape is compacted IN PLACE
 * (`compactQuarantineEntry` turns the SAME name from a directory into a
 * single empty file), so "still a directory" means "still needs work". A
 * `.compacting.*` name is different: `sweepLockQuarantine`'s own handling of
 * it (`lib/state/lock.ts`) restores/confirms a fence at the CANONICAL path
 * it names, then deletes the staging copy itself outright — so a
 * successful sweep makes the staging name DISAPPEAR, and checking for its
 * continued existence the same way as every other shape reads that success
 * as a failure (round-9's own fix reported "compaction did not complete"
 * after a genuinely successful recovery — docomply-review, a reference-implementation pull request
 * round 10).
 *
 * But the staging name disappearing is not the WHOLE story either: when the
 * canonical path didn't already exist, that same successful sweep CREATES
 * one — a tombstoned directory, restoring a fence rather than compacting
 * anything — and that path was never in `family.names` (it did not exist
 * when `classify()` ran, so nothing could have captured it). Checking only
 * the vanished staging name therefore reports success for a generation that
 * is still, in fact, an uncompacted multi-inode directory
 * (docomply-review, a reference-implementation pull request round 11). Resolved via the SAME
 * `COMPACTING_STAGING_RE` capture `sweepLockQuarantine` uses to find that
 * canonical path, and checked directly.
 */
export function anchorStillNeedsCompaction(
  stateDir: string,
  family: Family,
  anchor: string,
): boolean {
  for (const name of family.names) {
    if (!isSweepable(name) || anchorOf(name) !== anchor) continue;
    const p = join(stateDir, name);
    if (name.startsWith(".compacting.")) {
      if (existsSync(p)) return true;
      const canonical = COMPACTING_STAGING_RE.exec(name)?.[1];
      if (canonical === undefined) continue;
      try {
        if (statSync(join(stateDir, canonical)).isDirectory()) return true;
      } catch {
        return true;
      }
      continue;
    }
    try {
      if (statSync(p).isDirectory()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

interface Verdict {
  readonly family: Family;
  readonly action: "retire" | "compact";
  /** Why, in one clause — printed for every family, retired or not. */
  readonly reason: string;
}

/**
 * Re-checks the fast, LOCAL liveness signals a `retire` verdict depended on,
 * immediately before this family's own `rmSync` loop runs — not a re-derived
 * verdict, just the same live/unreadable-lease predicates judgePrFamily and
 * judgeActorFamily already used, run again right here.
 *
 * Every verdict for the WHOLE batch is computed up front, in one pass, before
 * any deletion starts (`main`'s `verdicts = [...families.values].map(...)`),
 * and compaction alone measures 9.8s per 40 anchors — minutes, on the
 * 113k-entry backlog an earlier change was filed against. A driver that starts and
 * claims/renews a lease in that window is invisible to the verdict computed
 * before it existed, so deleting on that stale verdict can destroy state a
 * now-live process just wrote (docomply-review + chatgpt-codex-connector, PR
 * #4197 round 3). This does not need full lock coordination with the
 * lease/lock claim protocol to close the practical gap — round 3's own
 * finding frames an immediate revalidation as a sufficient alternative — it
 * only needs the window narrowed from "the rest of this run's processing
 * time" down to "the gap between this call and the `rmSync` right after it",
 * which is what calling this immediately before that loop does.
 *
 * Still not airtight against a write landing in the syscalls between this
 * check and the `rmSync` itself — no read-then-delete pair over a plain file
 * ever is, without a lock this reaper does not take. Deliberately: closing it
 * would mean acquiring `leaseLock`/`treeLeaseLock`/`prRemoteMutationLock`
 * (none of which are exported, all of which carry a documented cross-caller
 * lock-ordering discipline every `claimPrLease`/`claimTreeLease`/
 * `guarded-push.ts` call in this repo depends on) around a delete that
 * removes the very `.lock` directory those locks live in — nothing else in
 * this codebase deletes a lock it holds, and `createLock`'s `release` has no
 * defined behaviour when its own directory disappears underneath it. A
 * mistake there wedges every concurrent drive-pr session in the repo, which
 * is categorically worse than the residual it would close: a family only
 * reaches this point after being proven PR-merged-or-gone, lease-free, AND
 * idle a full week, and this file's own retirement argument above (`##
 * RETIRE`) is that no parked human decision survives all of those — so the
 * worst case in the sub-syscall window is a lease file just written by a
 * driver that is itself about to terminate. That residual is accepted the
 * same way
 * `anchorsWithUncompactedWork`'s own compaction race is: "a driver can mint a
 * fresh [write] between this scan and the sweep … anything missed is picked
 * up next week" — except here a miss means NOT retiring rather than
 * under-compacting, so the failure mode this residual leaves is late
 * cleanup, never data loss.
 *
 * Re-checks EVERY mutable input the original verdict depended on, not just
 * the lease half — `minAgeMs`/`newestMtimeMs` and, for an actor family, the
 * live-worktree census are just as capable of going stale across a
 * multi-minute batch as a lease is, and leaving them frozen at batch-start
 * left a MINUTES-wide hole (a family member touched mid-batch, or a worktree
 * re-registered while the sweep ran) next to the lease check's sub-syscall
 * one (docomply-review, a reference-implementation pull request round 4). `liveKeys` is the caller's own
 * census — but resolving it ONCE for the whole deletion loop, ahead of time,
 * reopened the identical staleness gap one level up: this loop interleaves
 * retire AND compact actions, compacting an earlier family can itself take
 * minutes, and a census resolved before that started is exactly as stale as
 * the original verdict by the time a LATER actor retirement reaches this
 * call (docomply-review, a reference-implementation pull request round 7). The caller now resolves it FRESH
 * immediately before each actor-family call specifically, at the cost of one
 * `git worktree list` per actor retirement rather than one for the whole
 * batch — bounded by how many actor families are actually being retired,
 * not by the batch size. `null` for a PR-kind family, which never reads it.
 *
 * Returns `null` when still safe to retire, or the reason it is not —
 * `revalidationSkipped`'s reporting needs an accurate reason string per
 * family, not just a boolean that would have to be guessed at afterwards.
 */
export function retirementStillSafe(
  f: Family,
  stateDir: string,
  minAgeMs: number,
  liveKeys: Set<string> | null,
): string | null {
  if (f.kind === "pr") {
    if (liveLeasesFor(stateDir, f.subject).length > 0) {
      return "a lease was claimed or renewed since this verdict was computed";
    }
    if (unreadableLeaseFilesFor(stateDir, f.subject).length > 0) {
      return "an unreadable lease appeared since this verdict was computed";
    }
  } else {
    if (liveKeys === null) {
      return "the worktree list could not be re-read (failing closed)";
    }
    if (liveKeys.has(f.subject)) {
      return "the worktree was re-registered since this verdict was computed";
    }
    if (liveTreeLeaseFor(stateDir, f.subject)) {
      return "a tree lease was claimed or renewed since this verdict was computed";
    }
    if (treeLeaseUnreadableAndFreshFor(stateDir, f.subject)) {
      return "an unreadable tree lease appeared since this verdict was computed";
    }
  }
  const newest = newestMtimeMs(stateDir, f.names);
  if (newest === null) {
    return "a family member could not be stat’ed since this verdict was computed";
  }
  if (Date.now() - newest < minAgeMs) {
    return "a family member was touched since this verdict was computed";
  }
  return null;
}

/** Decide one PR family's fate. Every branch but the last one keeps it. */
function judgePrFamily(
  f: Family,
  stateDir: string,
  lifecycle: PrLifecycle,
  minAgeMs: number,
): Verdict {
  if (lifecycle !== "retired") {
    return {
      family: f,
      action: "compact",
      reason:
        lifecycle === "open"
          ? "PR is still open"
          : lifecycle === "closed"
            ? "PR is closed but not merged — reopenable, kept indefinitely"
            : "PR lifecycle could not be resolved (failing closed)",
    };
  }
  // The same predicate `reset` trusts to decide which lease it may not sweep,
  // rather than a re-derived one: a live lease is the only artefact that means
  // someone is driving RIGHT NOW, and a merged PR can still have a driver
  // mid-round on it (the merge may have landed seconds ago).
  const live = liveLeasesFor(stateDir, f.subject);
  if (live.length > 0) {
    return {
      family: f,
      action: "compact",
      reason: "a live lease still holds it",
    };
  }
  // A lease file that EXISTS but cannot be parsed is evidence some tree wrote
  // something, and is exactly the input a gate understands least. Within the
  // staleness window it blocks; `unreadableLeaseFilesFor` applies that window
  // itself, so a nonempty answer here is always a live-enough unknown.
  const unreadable = unreadableLeaseFilesFor(stateDir, f.subject);
  if (unreadable.length > 0) {
    return {
      family: f,
      action: "compact",
      reason: `${unreadable.length} unreadable lease file(s) (failing closed)`,
    };
  }
  const newest = newestMtimeMs(stateDir, f.names);
  if (newest === null) {
    return {
      family: f,
      action: "compact",
      reason: "a family member could not be stat’ed (failing closed)",
    };
  }
  const idleMs = Date.now() - newest;
  if (idleMs < minAgeMs) {
    return {
      family: f,
      action: "compact",
      reason: `touched ${Math.floor(idleMs / 86_400_000)}d ago, under the idle guard`,
    };
  }
  return {
    family: f,
    action: "retire",
    reason: `PR merged or gone from GitHub, no live lease, idle ${Math.floor(idleMs / 86_400_000)}d`,
  };
}

/** Decide one worktree family's fate. */
function judgeActorFamily(
  f: Family,
  stateDir: string,
  liveKeys: Set<string> | null,
  minAgeMs: number,
): Verdict {
  if (liveKeys === null) {
    return {
      family: f,
      action: "compact",
      reason: "worktree list unavailable (failing closed)",
    };
  }
  if (liveKeys.has(f.subject)) {
    return { family: f, action: "compact", reason: "worktree still exists" };
  }
  // `git worktree list` is not an exact existence predicate for the directory
  // this actor's tree lease names — its registration can be pruned or lost
  // by a git operation elsewhere while the checkout, and a process still
  // holding the lease, remain. This veto catches that case directly, the
  // same way `judgePrFamily`'s `liveLeasesFor` check does for the PR path,
  // rather than relying solely on the age gate below.
  if (liveTreeLeaseFor(stateDir, f.subject)) {
    return {
      family: f,
      action: "compact",
      reason: "a live tree lease still holds it",
    };
  }
  // A tree lease that EXISTS but cannot be parsed is evidence some process
  // wrote something, and `liveTreeLeaseFor` alone cannot distinguish that from
  // "no lease at all" — both read `null` off `readTreeLease`. Within the
  // staleness window it blocks, matching `judgePrFamily`'s
  // `unreadableLeaseFilesFor` check for the same reason (docomply-review, PR
  // #4197 round 2).
  if (treeLeaseUnreadableAndFreshFor(stateDir, f.subject)) {
    return {
      family: f,
      action: "compact",
      reason: "an unreadable tree lease (failing closed)",
    };
  }
  const newest = newestMtimeMs(stateDir, f.names);
  if (newest === null) {
    return {
      family: f,
      action: "compact",
      reason: "a family member could not be stat’ed (failing closed)",
    };
  }
  const idleMs = Date.now() - newest;
  if (idleMs < minAgeMs) {
    return {
      family: f,
      action: "compact",
      reason: `worktree gone but touched ${Math.floor(idleMs / 86_400_000)}d ago, under the idle guard`,
    };
  }
  return {
    family: f,
    action: "retire",
    reason: `worktree no longer exists, idle ${Math.floor(idleMs / 86_400_000)}d`,
  };
}

interface Args {
  readonly del: boolean;
  readonly json: boolean;
  readonly minAgeDays: number;
}

export function parseArgs(argv: readonly string[]): Args {
  let del = false;
  let json = false;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--delete") {
      del = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--min-age-days") {
      const v = argv[++i] ?? "";
      // `isDigits` alone does not bound magnitude: a long-enough digit string
      // (e.g. 400 nines) still passes it, but overflows `Number.parseInt` to
      // `Infinity`, which then clears `< 1` too — making `minAgeMs` infinite
      // and the idle guard never fire again, silently (docomply-review, PR
      // #4197 round 3). `Number.isSafeInteger` plus the same upper bound the
      // cron wrapper enforces on `REAP_CRON_MIN_AGE_DAYS` closes both ends.
      const parsed = isDigits(v) ? Number.parseInt(v, 10) : Number.NaN;
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_MIN_AGE_DAYS
      ) {
        fail(
          2,
          `reap-state.ts: --min-age-days must be an integer between 1 and ${MAX_MIN_AGE_DAYS}, got '${v}'.`,
          "It is the extra idle guard stacked on the lifecycle predicate; 0 would",
          "remove the only bound that survives a lifecycle answer being wrong, and",
          "an unbounded value can silently make the guard never fire at all.",
        );
      }
      minAgeDays = parsed;
    } else {
      fail(2, `reap-state.ts: unknown argument '${a}'.`);
    }
  }
  return { del, json, minAgeDays };
}

interface Snapshot {
  readonly entries: number;
  readonly timestampMs: number;
}

/**
 * Read this reaper's own persisted entry-count snapshot from a prior run, or
 * `null` if absent, unreadable, or malformed — every one of those just means
 * "no growth-rate comparison this run", never a hard failure (the snapshot
 * is diagnostic output, not a safety input anything else in this script
 * depends on).
 */
function readSnapshot(stateDir: string): Snapshot | null {
  try {
    const raw = readFileSync(join(stateDir, REAPER_SNAPSHOT_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as {
      entries?: unknown;
      timestampMs?: unknown;
    };
    if (
      typeof parsed.entries === "number" &&
      Number.isInteger(parsed.entries) &&
      parsed.entries >= 0 &&
      typeof parsed.timestampMs === "number" &&
      Number.isInteger(parsed.timestampMs) &&
      parsed.timestampMs >= 0
    ) {
      return { entries: parsed.entries, timestampMs: parsed.timestampMs };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist THIS run's entry count for the NEXT run's growth-rate comparison.
 * `entries` must be the count AFTER whatever compaction/retirement this run
 * performed (its own doc comment at the call site explains why). A failed
 * write costs only the next report's rate, never this run's own
 * correctness — but "costs only the rate" is not "costs nothing to know
 * about": returns the error message on failure rather than swallowing it,
 * so the call site can fold it into `failures` the same way every OTHER
 * mutating filesystem operation in this script already does (compaction,
 * retirement — see their own `failures.push` call sites), instead of this
 * one write being the sole silent exception to that convention
 * (docomply-review, a reference-implementation pull request round 4).
 *
 * Goes through `fsutil.ts`'s `atomicWrite` (write-fsync-rename via a unique
 * temp file) rather than a plain `writeFileSync`, which truncates the target
 * before writing its replacement: a crash or short write (ENOSPC/EDQUOT)
 * mid-write would otherwise destroy the prior valid snapshot and leave
 * `readSnapshot` reading malformed JSON as `null`, silently losing the
 * measurement interval (docomply-review, a reference-implementation pull request round 2) — the exact
 * failure mode this state module's every other durable write already
 * guards against.
 */
function writeSnapshot(stateDir: string, entries: number): string | null {
  try {
    atomicWrite(
      join(stateDir, REAPER_SNAPSHOT_FILENAME),
      JSON.stringify({ entries, timestampMs: Date.now() }),
    );
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The exclusive lock that serialises this run's ENTIRE read-verdict-mutate-
 * publish sequence — not just the retire/compact mutation — against a
 * SECOND `--delete` run of this same script racing the first.
 *
 * Neither the retire/compact loop nor `sweepLockQuarantine` needs this for
 * ITS OWN sake: every mutation there re-verifies its own precondition
 * immediately before acting (`retirementStillSafe`, `anchorStillNeedsCompaction`),
 * so two overlapping runs cannot double-remove or corrupt each other's work.
 * The growth-rate snapshot has no such re-verification — `postCleanupEntries`
 * is a plain `readdirSync` count with nothing to re-check against — and
 * `previousSnapshot`/`reportedEntries` are both read from disk before the
 * mutation even starts, so a run that reads them EARLY (because it started
 * first) can still WRITE its snapshot LAST (because it finished last),
 * silently overwriting a newer, correct snapshot with a stale one and
 * corrupting every future `growthPerDay` delta with no error anywhere. That
 * is why this must be held from the very first read on, not acquired later
 * around only the mutation (coderabbitai, PR #4516 round 6).
 *
 * Previously a bespoke `mkdirSync` + pid-file pair, deliberately not
 * `lib/state/lock.ts`'s `createLock` — on the argument that this lock guards
 * one single, short-lived, whole-process run rather than many concurrent
 * per-key claims held over hours, so it needed none of that module's
 * generation/quarantine machinery. That argument was wrong: it reintroduced
 * the exact races `createLock` exists to close. `mkdirSync(lockDir)`
 * succeeding and `writeFileSync`ing the pid file were two separate syscalls,
 * so a contender could observe the freshly-created-but-not-yet-owned
 * directory, read no pid file, conclude the (live) lock was stale, and
 * recursively remove it out from under its actual owner. And the stale-break
 * path itself was an ABA race: it read the holder as stale, then
 * unconditionally `rmSync`'d the directory with no re-check that it still
 * held the SAME generation it had just observed — a fresh holder that
 * acquired in between was removed just the same, letting two processes
 * believe they each hold the lock (docomply-review, a reference-implementation pull request round 6).
 * `createLock` closes both: it never treats a directory as owned until an
 * identity marker is published under its own short-lived `.recovering` gate,
 * and every stale-break moves the directory through a generation-keyed
 * `rename(2)` rather than a blind path-keyed `rmSync`, so a mismatch fails
 * the move outright instead of destroying a stranger's fresh lock. Getting
 * that right took that module several rounds on its own PR (see its header)
 * — re-deriving a narrower version of the identical protocol a third time in
 * THIS file, rather than reusing the one already hardened for it, is exactly
 * the variant-patching this class of finding keeps recurring on.
 *
 * The trade against the old protocol: staleness here is TIME-based
 * (`DRIVE_PR_LOCK_STALE_MIN`, default 10 minutes) rather than
 * `pidAlive`-based, so a crashed run's lock is not recoverable quite as
 * instantly. It still never blocks the next weekly cron "forever" — the
 * property the old comment promised — just within a bounded ten minutes
 * instead of immediately, which is the same trade every other lock in this
 * skill already makes.
 *
 * `acquire(DELETE_LOCK_MAX_WAIT_SEC)` at the call site, NOT `acquire(0)`:
 * `0` looks like the natural fit for "refuse immediately, never block a
 * weekly cron", but it is wrong for this caller specifically. Breaking a
 * stale holder does not itself complete an acquisition — it clears the
 * canonical path and lets the loop retry `mkdirSync` on its NEXT iteration —
 * and with `maxWaitSec: 0` the deadline (this call's own start instant) has
 * already passed by the time the stale-break's rename/verify/tombstone work
 * finishes, so the loop's unconditional bottom-of-iteration deadline check
 * throws `LockAcquireTimeoutError` before that retry ever runs. `0` therefore
 * makes recovery from a crashed prior run's stale lock permanently
 * impossible, not merely slower — every `--delete` invocation after a crash
 * would refuse forever instead of breaking the lock once and proceeding
 * (caught by this file's own test suite: a fixture backdating a lock past
 * the staleness window exited 1, not 0). A few seconds of budget is enough
 * for that one retry (the rename/tombstone work is microseconds) while still
 * refusing well within the same run's own definition of "fast" relative to a
 * weekly cadence; it also lets two invocations that merely started within a
 * moment of each other serialise instead of both failing outright.
 */
const DELETE_LOCK_MAX_WAIT_SEC = 3;
function deleteLock(stateDir: string): PathLock {
  return createLock(
    join(stateDir, DELETE_LOCK_ANCHOR),
    "reap-state.ts (delete)",
    "reap-state-delete",
  );
}

/**
 * Keeps `deleteLock` alive across a run long enough to outlast its own
 * staleness window — this file documents an expected first-run duration of
 * about 12 minutes, longer than `createLock`'s default 10-minute stale
 * window, so a run that never refreshes its hold can have that hold broken
 * by a contending `--delete` invocation while it is still very much alive,
 * letting the two overlap and corrupt `growthPerDay` (`coderabbitai`/
 * `chatgpt-codex-connector`, PR #4516). A background `setInterval` alone
 * does not cover it: this function's caller spends most of its time inside
 * synchronous `rmSync`/`sweepLockQuarantine` work with no `await` between
 * calls, and a JS timer cannot fire until the current synchronous stretch
 * returns control to the event loop — so `main()`'s own loops call the
 * returned function directly at points a timer can never reach.
 *
 * Returns a no-op when `lock` is `null` (dry run, nothing held) so every
 * call site can invoke it unconditionally rather than null-checking `lock`
 * itself at each one. Throttled to `lockHeartbeatMs()` — not called on every
 * loop iteration unconditionally — because the underlying `PathLock.touch()`
 * is not free: it mints a fresh permanent `.recovering.stale.*` tombstone on
 * every call (`touch()`'s own doc comment), so touching once per entry
 * across a run processing thousands of them would itself inflate the exact
 * quarantine growth this script exists to measure and shrink.
 */
function makeSyncHeartbeat(lock: PathLock | null): () => void {
  let lastTouchMs = Date.now();
  return () => {
    if (lock === null) return;
    const now = Date.now();
    if (now - lastTouchMs < lockHeartbeatMs()) return;
    lastTouchMs = now;
    lock.touch();
  };
}

/**
 * `resolveStateDir()`, except on a bare (no `--delete`) run — there,
 * `resolveStateDir()`'s own `defaultStateDirFor()`/`ensureMigratedFromLegacy()`
 * mint a clone identity, create the new state directory, and may write the
 * migration marker, merely to answer "where does state live", violating
 * this reaper's own "DRY RUN — nothing changed" contract (docomply-review,
 * a reference-implementation pull request round 14). Delegates to `store.ts`'s `peekResolvedStateDir()`,
 * which already handles the `$DRIVE_PR_STATE_DIR` override identically.
 */
async function resolveStateDirForReport(dryRun: boolean): Promise<string> {
  return dryRun ? peekResolvedStateDir() : resolveStateDir();
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = await resolveStateDirForReport(!args.del);

  // `resolveStateDir()` deliberately leaves a `$DRIVE_PR_STATE_DIR` override
  // unmaterialised — see `store.ts`'s own doc comment on that branch — so an
  // override pointed at a location nothing has written to yet is absent, not
  // an error. Handled HERE, before `deleteLock(stateDir)`: `createLock`'s
  // `acquire()` treats every `mkdirSync` failure alike (a bare `try`/`catch`
  // around it — see `lock.ts`), so mkdir-ing a lock directory under a
  // NONEXISTENT parent fails with ENOENT on every retry, is indistinguishable
  // there from live contention, and after `DELETE_LOCK_MAX_WAIT_SEC` reports a
  // misleading lock-timeout error instead of the true "nothing to reap yet"
  // (coderabbitai, PR #4618 round 6). Bounded either way — this is not an
  // indefinite hang — but the message a reader gets back should name what
  // actually happened.
  if (!existsSync(stateDir)) {
    if (args.json) {
      console.log(
        JSON.stringify({ stateDir, exists: false, entries: 0 }, null, 2),
      );
    } else {
      console.log(
        `reap-state.ts: ${stateDir} does not exist yet — nothing to reap.`,
      );
    }
    return 0;
  }

  // Serialises this run's ENTIRE read-verdict-mutate-publish sequence — not
  // just the retire/compact mutation below — against a CONCURRENT `--delete`
  // run of this same script. Acquired here, before the FIRST read, because
  // the growth-rate snapshot has no per-write re-verification of its own to
  // fall back on (see `deleteLock`'s doc comment): a run admitted past this
  // point works from a state dir no other `--delete` run can read from or
  // publish into until this one releases it. Dry runs never reach here at
  // all: nothing from this point on mutates or publishes without `--delete`,
  // so they take no lock and race nothing.
  const lock = args.del ? deleteLock(stateDir) : null;
  if (lock !== null) await lock.acquire(DELETE_LOCK_MAX_WAIT_SEC);

  // `touchLock` is the SAME throttled function used both from the interval
  // below (covers every `await` boundary in the body — `prLifecycles`,
  // `liveWorktreeKeys`) and called directly inside the loop further down
  // (covers the synchronous stretches a timer cannot reach — see
  // `makeSyncHeartbeat`'s own doc comment). `null` when nothing was
  // acquired (dry run), so there is nothing to heartbeat.
  const touchLock = makeSyncHeartbeat(lock);
  const lockHeartbeat =
    lock === null ? null : setInterval(touchLock, lockHeartbeatMs());

  try {
    let names: string[];
    try {
      names = readdirSync(stateDir);
    } catch (e) {
      // Not `[]`: an enumeration that FAILED is indistinguishable from an
      // empty state dir, and reporting "nothing to reap" for an EACCES would
      // tell an operator the sweep ran clean when it never looked at anything.
      console.error(
        `reap-state.ts: cannot enumerate ${stateDir}: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 1;
    }
    // Excludes this reaper's own snapshot file (and its atomic-write temp-file
    // shape) and its delete-run lock's whole family — see `isReapOwnArtifact`'s
    // doc comment. Reported as `entries` below; also what the growth-rate
    // comparison is computed against, so counting any bookkeeping artifact
    // would make a run read as one extra entry that was never actually part
    // of the backlog.
    const reportedEntries = names.filter((n) => !isReapOwnArtifact(n)).length;

    const previousSnapshot = readSnapshot(stateDir);
    // Captured once and reused for both the guard and the arithmetic below —
    // two separate `Date.now()` calls let a clock adjustment between them pass
    // the guard with the first read and then produce a zero or negative
    // denominator with the second (docomply-review, a reference-implementation pull request).
    const nowForGrowthMs = Date.now();
    const growthPerDay =
      previousSnapshot !== null && nowForGrowthMs > previousSnapshot.timestampMs
        ? ((reportedEntries - previousSnapshot.entries) /
            (nowForGrowthMs - previousSnapshot.timestampMs)) *
          86_400_000
        : null;

    const { families, foreign, unrecognised } = classify(names);
    const minAgeMs = args.minAgeDays * 86_400_000;

    const prs = [...families.values()]
      .filter((f) => f.kind === "pr")
      .map((f) => f.subject);
    const lifecycles = await prLifecycles(prs);
    const liveKeys = await liveWorktreeKeys();

    const verdicts = [...families.values()].map((f) =>
      f.kind === "pr"
        ? judgePrFamily(
            f,
            stateDir,
            lifecycles.get(f.subject) ?? "unknown",
            minAgeMs,
          )
        : judgeActorFamily(f, stateDir, liveKeys, minAgeMs),
    );

    let retirable = 0;
    let removed = 0;
    let compactable = 0;
    let compacted = 0;
    const failures: string[] = [];
    const revalidationSkipped: {
      id: string;
      entries: number;
      reason: string;
    }[] = [];
    const incompleteRetirements: {
      id: string;
      entries: number;
      failedEntries: number;
    }[] = [];

    for (const v of verdicts) {
      // Throttled — see `makeSyncHeartbeat`'s own doc comment — so this is
      // safe to call unconditionally once per family regardless of how many
      // families this run processes.
      touchLock();
      if (v.action === "retire") {
        retirable += v.family.names.length;
        if (!args.del) continue;
        // Re-checked HERE, immediately before deleting THIS family, rather than
        // trusting the verdict computed earlier in the batch — see
        // `retirementStillSafe`'s own doc comment for why the gap between the
        // two can be minutes, not microseconds. The worktree census is resolved
        // FRESH right here too, per actor family, rather than once for the
        // whole loop: this loop interleaves retire AND compact actions, and
        // compaction of an EARLIER family can itself take minutes, so a census
        // resolved before the loop started is exactly as stale as the verdict
        // itself by the time a LATER actor retirement reaches this line
        // (docomply-review, a reference-implementation pull request round 7 — a second instance of the same
        // batch-vs-per-family staleness class round 4's finding was about,
        // this time in the fix for it). `null` for a PR-kind family, which
        // never reads this argument, to avoid a wasted `git worktree list`.
        const liveKeysNow =
          v.family.kind === "actor" ? await liveWorktreeKeys() : null;
        const skipReason = retirementStillSafe(
          v.family,
          stateDir,
          minAgeMs,
          liveKeysNow,
        );
        if (skipReason !== null) {
          revalidationSkipped.push({
            id: v.family.id,
            entries: v.family.names.length,
            reason: skipReason,
          });
          // Deliberately NOT `continue`d here — falls through to the same
          // COMPACT logic below that an `action === 'compact'` verdict runs.
          // A vetoed retirement means the family is still in use (a lease,
          // the idle guard, or the worktree census changed since the verdict
          // was computed), which is exactly the population compaction has no
          // precondition against — `sweepLockQuarantine`'s own doc comment,
          // and the module header's "COMPACT — applied to every `createLock`
          // anchor still in use. Needs no precondition at all." A bare
          // `continue` here left every newly-active family — the ones this
          // predicate exists to protect — permanently uncompacted, exactly
          // the population most likely to keep minting fresh quarantine
          // entries, contradicting the unconditional-compaction promise
          // (docomply-review, a reference-implementation pull request round 19).
        } else {
          // Tracked per-family, not just globally in `failures` — a family with
          // even one failed removal is NOT cleanly retired, and reporting it as
          // `RETIRED` (console) or including it in `retire[]` (JSON) alongside
          // families that truly are is the exact ambiguity round 5's
          // `skippedReason` design fixed for vetoed families, recurring here for
          // failed ones instead: a reader has no signal that "retained state"
          // sits behind a family this report calls fully retired
          // (coderabbitai, PR #4197 round 25).
          let familyFailed = 0;
          for (const n of v.family.names) {
            touchLock(); // throttled — see `makeSyncHeartbeat`
            const p = join(stateDir, n);
            try {
              // `force: true` makes `rmSync` a silent no-op on an already-absent
              // path rather than throwing — which means a bare unconditional
              // count credits `removed` for an entry this call never actually
              // found, let alone removed (docomply-review, a reference-implementation pull request round 5).
              // Checked immediately before the call, so this narrows rather than
              // reopens the window: a path vanishing in the gap between the
              // `existsSync` and the `rmSync` right after it still counts as
              // removed here, same as it always would have, but a path already
              // gone BEFORE this loop reached it (revalidation raced a
              // concurrent cleanup, not a concurrent claim) no longer is.
              if (existsSync(p)) {
                rmSync(p, { recursive: true, force: true });
                removed++;
              }
            } catch (e) {
              familyFailed++;
              failures.push(
                `${n}: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
          if (familyFailed > 0) {
            incompleteRetirements.push({
              id: v.family.id,
              entries: v.family.names.length,
              failedEntries: familyFailed,
            });
          }
          continue; // attempted this family's retirement either way — nothing
          // left for it to fall through to compaction for
        }
      }
      // COMPACT. Counted per ANCHOR, since `sweepLockQuarantine` reports nothing
      // back — the entry count it shrinks is not observable from here without a
      // second enumeration.
      const todo = anchorsWithUncompactedWork(stateDir, v.family);
      compactable += todo.size;
      if (!args.del) continue;
      for (const anchor of todo) {
        touchLock(); // throttled — see `makeSyncHeartbeat`
        // A single anchor's own quarantine can itself hold thousands of
        // entries with no `await` anywhere in `sweepLockQuarantine`'s loop —
        // `touchLock` passed as `onEntry` covers that span too, not just the
        // gap between anchors.
        sweepLockQuarantine(join(stateDir, anchor), touchLock);
        // `sweepLockQuarantine` swallows every internal write failure — verify
        // the postcondition directly rather than trusting a `void` return that
        // cannot distinguish "compacted" from "silently did nothing" (see
        // `anchorStillNeedsCompaction`'s own doc comment). `compacted` is
        // credited only on confirmed success, mirroring `removed`'s own
        // per-entry accounting on the retire path — crediting it unconditionally
        // here reported success for an anchor `anchorStillNeedsCompaction` had
        // just proven still needed work (docomply-review, a reference-implementation pull request round 15).
        if (anchorStillNeedsCompaction(stateDir, v.family, anchor)) {
          failures.push(`${anchor}: compaction did not complete`);
        } else {
          compacted++;
        }
      }
    }

    // A revalidation-vetoed `retire` verdict falls through into the SAME
    // compaction path an `action === 'compact'` verdict runs (see the veto
    // branch above) — so it is "kept" in every observable sense: it survives
    // on disk and is compacted like any other in-use family. Only ever
    // populated under `--delete` (revalidation does not run in a dry run), so
    // this correctly adds nothing to a `would retire` family that dry-run mode
    // never actually revalidates. Omitting these from `keep`/`kept N` produced
    // exactly the contradiction `SKIPPED (revalidation)` immediately followed
    // by `kept 0 families` even though that same family was compacted in the
    // same run (docomply-review, a reference-implementation pull request round 24).
    const revalidationSkippedIds = new Set(
      revalidationSkipped.map((s) => s.id),
    );
    const isKept = (v: Verdict) =>
      v.action === "compact" || revalidationSkippedIds.has(v.family.id);
    const incompleteRetirementIds = new Set(
      incompleteRetirements.map((r) => r.id),
    );

    // The final entry-count WARNING must reflect what THIS run leaves behind,
    // not the census taken near the start of `main` before its own deletions
    // — a run that retires enough families to drop below the threshold must
    // not still warn on the pre-cleanup count (docomply-review, a reference-implementation pull request).
    // Re-enumerated fresh rather than reconstructed as `reportedEntries -
    // removed`, for the same reason the snapshot's own post-cleanup count
    // below is: a concurrent driver adding or removing entries during this
    // run is invisible to arithmetic over this run's own counters. Dry-run
    // mode deletes nothing, so `reportedEntries` already is the post-run
    // count there.
    // `null` means the final enumeration itself failed and no count is
    // available — never reconstructed as `reportedEntries - removed`, which
    // silently assumes no concurrent driver added or removed entries during
    // this run's own window and can therefore both warn on a stale wrong
    // number and persist that same wrong number as next run's growth-rate
    // baseline (coderabbitai, PR #4612 round 12).
    let postCleanupEntries: number | null = reportedEntries;
    if (args.del) {
      try {
        postCleanupEntries = readdirSync(stateDir).filter(
          (n) => !isReapOwnArtifact(n),
        ).length;
      } catch (e) {
        postCleanupEntries = null;
        failures.push(
          `post-cleanup enumeration of ${stateDir} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Only attempted when a warning could actually fire: `resolveLegacyStateDir()`
    // spawns `git`, which an override-set-outside-any-git-repo run (this
    // suite's own git-failure fixtures do exactly this for unrelated reasons)
    // cannot always answer, and this advisory wording is not worth spending
    // that call — or risking it — on every ordinary, healthy run.
    const alreadyRelocated =
      postCleanupEntries !== null &&
      postCleanupEntries >= ENTRY_COUNT_WARN_THRESHOLD
        ? await computeAlreadyRelocatedForStateDir(stateDir, args.del)
        : false;
    const entryCountWarning =
      postCleanupEntries === null
        ? null
        : entryCountWarningFor(postCleanupEntries, alreadyRelocated);

    const report = {
      stateDir,
      entries: reportedEntries,
      // an earlier change acceptance criterion 3 — a regression in the generation rate
      // must surface as a NUMBER in this report, not require a human to diff
      // two runs' `entries` fields by hand days apart. `null` on the first run
      // ever (no prior snapshot) or when this run's clock did not advance past
      // the prior snapshot's timestamp. Computed as CURRENT pre-cleanup vs the
      // PRIOR run's post-cleanup count (persisted at the end of `main`, below)
      // — comparing two pre-cleanup counts instead would fold that prior run's
      // own removals into the delta, understating (or masking entirely) a
      // real regression in how fast entries are being minted.
      previousSnapshot,
      growthPerDay,
      entryCountWarning,
      families: families.size,
      // `retire` and `keep` are disjoint outcome sets — a family vetoed by
      // `retirementStillSafe` is excluded here and appears in `keep` instead
      // (round 24's `isKept`), carrying the veto's own reason there. Round 5's
      // original design instead kept a vetoed family IN `retire` with a
      // per-entry `skippedReason` flag, on the argument that a `retire` array
      // with no signal that some members were vetoed reads as "these were
      // retired" even when they were not — but round 24 made `keep` the place
      // that signal actually lives now, so leaving the SAME family in both
      // arrays just relocated the ambiguity: a consumer treating `retire` and
      // `keep` as disjoint (a reasonable assumption neither name disclaims)
      // saw one family in both, one of them lying about what happened to it
      // (docomply-review, a reference-implementation pull request round 25). `revalidationSkipped` remains
      // the definitive per-family audit trail of what was vetoed and why.
      retire: verdicts
        .filter(
          (v) =>
            v.action === "retire" &&
            !revalidationSkippedIds.has(v.family.id) &&
            !incompleteRetirementIds.has(v.family.id),
        )
        .map((v) => ({
          id: v.family.id,
          entries: v.family.names.length,
          reason: v.reason,
        })),
      keep: verdicts.filter(isKept).map((v) => ({
        id: v.family.id,
        entries: v.family.names.length,
        reason:
          v.action === "compact"
            ? v.reason
            : (revalidationSkipped.find((s) => s.id === v.family.id)?.reason ??
              v.reason),
      })),
      untouched: {
        foreignLocks: foreign.length,
        unrecognised: unrecognised.length,
      },
      applied: args.del,
      // Already exact — `removed` counts only entries that existed and were
      // actually removed (see the deletion loop), so no `failures.length`
      // subtraction is needed or correct here any more: a failed entry was
      // never added to `removed` in the first place.
      entriesRemoved: args.del ? removed : 0,
      entriesRetirable: retirable,
      // `anchorsCompactable` is the candidate count (works in both modes, like
      // `entriesRetirable`); `anchorsCompacted` credits only anchors
      // `anchorStillNeedsCompaction` confirmed actually shrank — crediting the
      // candidate count unconditionally reported success for anchors a
      // read-only filesystem (or any other swallowed write failure) left
      // untouched (docomply-review, a reference-implementation pull request round 15).
      anchorsCompactable: compactable,
      anchorsCompacted: args.del ? compacted : 0,
      failures,
      // Verdicted `retire` but NOT deleted this run because `retirementStillSafe`
      // found a mutable input (a lease, the idle guard, or the worktree census)
      // had changed since the verdict was computed. Not a failure — the next
      // weekly run re-judges these fresh. These families are excluded from
      // `retire` above and appear in `keep` instead (round 25).
      revalidationSkipped,
      // At least one entry's `rmSync` failed — this family is neither cleanly
      // retired (some of its state survives) nor kept (most of it is gone), a
      // THIRD outcome distinct from both `retire` and `keep`, so it is excluded
      // from both rather than misreported as either. `failedEntries` is a
      // subset of `entries`; the specific failures are in `failures` above.
      // The next weekly run retries whatever remains (coderabbitai, PR #4197
      // round 25).
      incompleteRetirements,
    };

    // Gated on `--delete`, like every other mutation this script performs —
    // "DRY RUN — nothing changed" is this script's own established contract
    // (below, and the whole `dry run` test suite), and a snapshot write is a
    // filesystem mutation like any other. Persists `postCleanupEntries`
    // (computed above, fresh off disk rather than reconstructed as
    // `reportedEntries - removed`: `reportedEntries` is a census taken near
    // the START of `main`, and this loop can run for minutes, so a concurrent
    // driver adding or removing entries during that window would otherwise be
    // permanently absent from every future growth-rate delta — docomply-review,
    // a reference-implementation pull request), so the snapshot and the warning above agree on what this run
    // actually left behind.
    // Skipped when `postCleanupEntries` is `null` — the failed enumeration
    // above already recorded a failure, and persisting a growth-rate
    // baseline computed from no real count would poison every future delta
    // against a number this run never actually measured.
    if (args.del && postCleanupEntries !== null) {
      const snapshotError = writeSnapshot(stateDir, postCleanupEntries);
      if (snapshotError !== null) {
        failures.push(
          `snapshot: failed to persist growth-rate snapshot: ${snapshotError}`,
        );
      }
    }

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `reap-state.ts: ${reportedEntries} entries in ${stateDir}, ${families.size} families`,
      );
      if (growthPerDay !== null) {
        const sign = growthPerDay >= 0 ? "+" : "";
        // `toFixed(0)` used to round anything under 0.5/day to `+0`, hiding
        // real positive growth between sweeps spaced further apart than a
        // day — three new entries between weekly runs is +0.43/day, which a
        // human skimming this line would read as "no growth" (chatgpt-codex-
        // connector, PR #4516). One fractional digit is enough to keep that
        // visible without cluttering the common case of a larger delta.
        console.log(
          `  growth since last run: ${sign}${growthPerDay.toFixed(1)} entries/day (was ${previousSnapshot?.entries} entries at ${new Date(previousSnapshot?.timestampMs ?? 0).toISOString()})`,
        );
      }
      // Printed after the count and the growth line so the WARNING lands next
      // to the two numbers that justify it, and prefixed `WARNING:` to match
      // what `reap-conductor-worktrees-cron.sh` already emits for every other
      // condition an operator has to act on — a weekly log is only a check if
      // the bad case looks different from the good one.
      if (entryCountWarning !== null) {
        console.log(`  WARNING: ${entryCountWarning}`);
      }
      const skipReasonById = new Map(
        revalidationSkipped.map((s) => [s.id, s.reason]),
      );
      const failedEntriesById = new Map(
        incompleteRetirements.map((r) => [r.id, r.failedEntries]),
      );
      for (const v of verdicts.filter((x) => x.action === "retire")) {
        const skipReason = skipReasonById.get(v.family.id);
        const failedEntries = failedEntriesById.get(v.family.id);
        const verb = !args.del
          ? "would retire"
          : skipReason !== undefined
            ? "SKIPPED (revalidation)"
            : failedEntries !== undefined
              ? "INCOMPLETE (see FAILED lines below)"
              : "RETIRED";
        const detail =
          failedEntries !== undefined
            ? `${failedEntries} of ${v.family.names.length} entries failed to remove`
            : (skipReason ?? v.reason);
        console.log(
          `  ${verb} ${v.family.id} (${v.family.names.length} entries) — ${detail}`,
        );
      }
      console.log(
        `  kept ${verdicts.filter(isKept).length} family/families; ${
          args.del
            ? `compacted ${compacted} of ${compactable} candidate lock anchor(s)`
            : `would compact ${compactable} lock anchor(s)`
        }`,
      );
      console.log(
        `  untouched: ${foreign.length} foreign lock(s), ${unrecognised.length} unrecognised entry/entries`,
      );
      if (!args.del) {
        console.log("  DRY RUN — nothing changed. Pass --delete to act.");
      }
      for (const f of failures) console.log(`  FAILED ${f}`);
    }

    // A per-entry removal failure IS reported nonzero: the cron wrapper's own
    // contract (reap-conductor-worktrees-cron.sh, "the RESULT line reflects
    // the worst status from either reaper") depends on this script's exit
    // code, not just its log lines, to know a removal failed. Returning 0
    // here made every such failure invisible to that RESULT line — the next
    // weekly run still retries it, but nothing before this flagged that it
    // was needed.
    return failures.length === 0 ? 0 : 1;
  } finally {
    // Stopped before `release()`, mirroring `guarded-push.ts`'s own ordering
    // — a heartbeat firing after release would touch a hold this process no
    // longer owns (`touch()` no-ops on that, per its own doc comment, but
    // there is nothing left for it to protect either way).
    if (lockHeartbeat !== null) clearInterval(lockHeartbeat);
    // Released only after the report and console output above have settled
    // (both read-only, never a reason to hold this open longer): a genuine
    // second racer waiting on this lock should wait no longer than the
    // read-verdict-mutate-publish sequence it actually protects.
    if (lock !== null) {
      lock.release();
      // This lock's own quarantine is otherwise unreachable by anything else
      // in this file: `deleteLock`'s anchor is deliberately excluded from the
      // family system entirely (`isReapOwnArtifact`), so it owns no
      // `LOCK_ANCHORS` entry for the retire/compact loop above to compact it
      // through. Compaction "needs no precondition at all" (this module's own
      // header), and running it HERE — after `release()`, not before — lets
      // it shrink even the tombstone this run's own clean release just
      // minted, alongside any older one left by a broken stale holder,
      // rather than always leaving the latest one for the NEXT run to find.
      sweepLockQuarantine(join(stateDir, DELETE_LOCK_ANCHOR));
    }
  }
}

// Guarded, the same way drive.ts and summary-findings.ts guard their own
// entry (and for the identical portability reason documented there —
// `import.meta.main` is Bun-only on the Node versions this skill supports).
// Unguarded, merely IMPORTING this module for its exported `anchorOf` /
// `classify` / `retirementStillSafe` — exactly what the test suite does —
// ran the whole reaper against the importing process's own argv: on a
// developer clone with real drive-pr families, that means real `gh pr view`
// and `git worktree list` calls, and a stray `--delete`-shaped argv would
// have deleted real state from a test import (chatgpt-codex-connector, PR
// #4197 round 5).
//
// `process.argv[1]` wrapped in `realpathSync` — measured (not merely
// suspected): a symlinked invocation path (a symlinked checkout, common for
// a cron job's working copy) leaves `process.argv[1]` UNRESOLVED under Node
// (verbatim as invoked) while `fileURLToPath(import.meta.url)` is already
// canonical (the module loader resolves it), so the two compared unequal and
// the guard silently skipped `main()` — the scheduled reaper would do
// nothing while still exiting 0 (coderabbitai, PR #4197 round 17). Bun
// itself was measured to already canonicalize `argv[1]`, so this specific
// gap never fires under the production cron invocation (which always uses
// bun) — but Node compatibility is this skill's own explicit, tested
// requirement, so it still needed closing. `existsSync` is checked first:
// `realpathSync` throws ENOENT on a path that does not exist, and an
// unreadable/nonexistent argv[1] is exactly the case this guard should fail
// closed on (treat as "not the entry point"), not crash on. `existsSync`
// returning true is not enough on its own, though — `realpathSync` can still
// throw EACCES or ELOOP (a permission-denied directory in the path, or a
// symlink cycle) even on a path that demonstrably exists, and an uncaught
// throw here is a MODULE-LEVEL exception: it fails not just `main()` but a
// PLAIN IMPORT of this module for `anchorOf`/`classify`/
// `retirementStillSafe` (exactly what the test suite does), which is a
// strictly worse failure mode than the "silently skip main()" bug this
// guard exists to fix (chatgpt-codex-connector and coderabbitai, PR #4197
// round 18). The `try` covers both calls so either one failing closes the
// same way.
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
  runMain("reap-state.ts", main);
}

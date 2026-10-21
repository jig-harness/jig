/**
 * The durable per-PR state store: where the file lives, how it is read
 * (fail-closed), and how it is written (atomically, under the lock, with the
 * handoff regenerated in the same hold).
 *
 * State lives OUTSIDE the repository tree, under `~/.local/state/jig/drive-pr/`,
 * keyed per clone: it is per-clone, never committed, and
 * survives across separate invocations hours apart. await-round.ts keeps its
 * separate review-round counter in the worktree's Git directory.
 * $DRIVE_PR_STATE_DIR relocates the root while retaining the clone key.
 * An inherited resolved clone leaf is idempotent. Unscoped legacy artifacts
 * refuse until explicitly relocated; no runtime migration adopts unknown owners.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ExitError, fail, sleep, testDelaySeconds } from "../cli.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";
import { scopedOverrideDir } from "./override-dir.ts";
import { worktreeKey } from "./actor.ts";
import { cloneKey, peekCloneKey } from "./clone-key.ts";
import { atomicWrite } from "./fsutil.ts";
import { renderHandoff } from "./handoff.ts";
import {
  ensureMigratedFromLegacy,
  legacyFootprint,
  migratedMarkerPath,
} from "./legacy-state.ts";
import { createLock, type PathLock } from "./lock.ts";
import { warnAboutOrphans } from "./orphans.ts";
import { type DriveState, freshState, isUsableState } from "./schema.ts";

/**
 * `--git-common-dir`, NOT `--git-dir`. In a linked worktree the latter
 * resolves to that worktree's PRIVATE `.git/worktrees/<name>`, so the same PR
 * gets an independent round budget and an independent parked set per worktree
 * — a second worktree re-arms an arbiter escalation the first one parked, and
 * restarts a bound that is supposed to be durable. This repository is driven
 * from Conductor worktrees as the normal case, so that is the common path, not
 * the exotic one. `--git-common-dir` is the clone-wide directory in both
 * layouts (it prints `.git` in an ordinary clone) — this is `cloneKey`'s
 * input, and the legacy state directory. It can print a RELATIVE path, so
 * it is resolved against the cwd before use.
 *
 * The default: `~/.local/state/jig/drive-pr/<cloneKey>/`, never inside the
 * repository tree. `.git/` grows one PERMANENT quarantine entry per
 * `createLock` acquire/release cycle — every read-modify-write of
 * every PR's state mints one on the happy path, and the only thing that ever
 * removes an entry (RETIRE) never fires for a worktree that still exists,
 * which is the Conductor norm. Measured at 256,932 entries and a 16s cold
 * `readdir` on one developer machine, paid by every git-aware tool that walks
 * the project, not just this skill.
 *
 * `ensureMigratedFromLegacy` (`legacy-state.ts`) is the safety gate this
 * relocation needs before it can be a DEFAULT rather than an opt-in: without
 * it, a session on new code silently resolves to an empty new-location state
 * file while a session on old code (or one that has not yet migrated) is still
 * writing to `--git-common-dir`, and each one's writes are invisible to the
 * other — exactly the failure an earlier manual relocation already hit once, by
 * hand, with no error surfaced either time. See that module's doc comment for
 * the full guarantee and its one deliberate gap (a marker-gated check, not a
 * per-call one, to avoid reintroducing the very `readdir` cost this relocation
 * exists to eliminate).
 */
/**
 * Validates and resolves `$DRIVE_PR_STATE_DIR`, or `null` when it is unset —
 * shared by `resolveStateDir()` and `peekResolvedStateDir()` so this
 * validation lives in exactly one place. Never has a side effect either way:
 * see the override branch's own comment on the (still-relevant) callers below.
 */
function resolvedOverride(): string | null {
  const override = process.env.DRIVE_PR_STATE_DIR ?? "";
  if (override === "") return null;
  // A RELATIVE override resolves against `process.cwd()`, which a human-or
  // config-supplied path has no fixed anchor for the way git's own dir does —
  // so two participants launched from different working directories (the base
  // checkout and a linked worktree, in particular) would resolve the identical
  // override string to two DIFFERENT absolute directories, recreating exactly
  // the split state/lease hazard this variable exists to let an operator opt
  // OUT of. Fail closed rather than silently picking one cwd's answer — a
  // config mistake here must not present as a working relocation that only
  // sometimes shares state.
  if (!isAbsolute(override)) {
    fail(
      2,
      `drive-state.ts: $DRIVE_PR_STATE_DIR must be an absolute path, got: ${override}`,
      "A relative override resolves against the current working directory,",
      "so two participants launched from different directories (the base",
      "checkout and a linked worktree, in particular) would silently resolve",
      "it to two different state directories.",
    );
  }
  // This validates the root; scopedOverrideDir preserves clone isolation and
  // refuses unscoped history. Default/git-common-dir migration still needs an
  // explicit source when an operator relocates the root.
  // Unlike the default below, never `mkdirSync`ed here: this path was `--git-common-dir`
  // older (always present, never created by this function), and a
  // caller relying on "an override that does not yet exist stays absent"
  // (`release-sessionless-lease.ts`'s no-op path, whose own test asserts
  // exactly this) would silently start seeing a directory materialise
  // underneath it. `openStore()` still creates it when IT needs to.
  return resolve(override);
}

export async function resolveStateDir(): Promise<string> {
  const overridden = resolvedOverride();
  if (overridden !== null)
    return scopedOverrideDir(overridden, await resolveLegacyStateDir());
  const legacyDir = await resolveLegacyStateDir();
  const newDir = defaultStateDirFor(legacyDir);
  ensureMigratedFromLegacy(legacyDir, newDir);
  return resolve(newDir);
}

/**
 * Read-only equivalent of `resolveStateDir()` — for a caller that only needs to
 * know where state currently lives, never to admit itself into it. Honors
 * `$DRIVE_PR_STATE_DIR` with a read-only clone-key lookup; on the default path,
 * defers to `peekStateDir()` instead of minting
 * a clone identity, creating the directory, or writing the migration marker
 * (`drives.ts`'s fleet listing and `--here` SessionStart-banner path both
 * called the mutating `resolveStateDir()` despite describing themselves as
 * read-only inspection — the same class of gap `peekStateDir()` closes for
 * `reap-state.ts`'s dry-run path).
 */
export async function peekResolvedStateDir(): Promise<string> {
  const overridden = resolvedOverride();
  if (overridden !== null)
    return scopedOverrideDir(overridden, await resolveLegacyStateDir(), true);
  return peekStateDir(await resolveLegacyStateDir());
}

/**
 * The older default — `--git-common-dir`, resolved to an absolute
 * path. Exported (alongside `defaultStateDirFor`) so `migrate-legacy-state.ts`
 * computes the identical legacy/new pair `resolveStateDir` does, rather
 * than a second copy of this resolution that could drift from it.
 */
export async function resolveLegacyStateDir(): Promise<string> {
  // Deadlined: this runs on the SessionStart `--here` path, where a hung git
  // on a stalled filesystem would otherwise outlive the outer hook's timeout
  // and turn "could not check" into silence — the one thing the banner's
  // contract forbids.
  // Scrubbed of GIT_DIR / GIT_WORK_TREE: a hook-launched driver inherits them
  // for another checkout and they outrank the cwd, which would key the state
  // dir (and every lock under it) to THAT checkout while the worktree key
  // names the real one.
  // A pass can change its shell cwd; its state still belongs to the tree
  // the driver pinned, exactly as worktree/hold attribution does.
  const cwd = process.env.DRIVE_PR_WORKTREE || process.cwd();
  const r = await git(["rev-parse", "--git-common-dir"], {
    cwd,
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
  });
  const legacyDir = r.code === 0 ? resolve(cwd, r.stdout.trim()) : "";
  if (legacyDir === "") {
    fail(
      2,
      "drive-state.ts: no state dir (cannot resolve this clone's Git common directory).",
      "A state-root override still requires this clone identity.",
    );
  }
  return legacyDir;
}

/** The default, given an already-resolved legacy dir. */
export function defaultStateDirFor(legacyDir: string): string {
  return join(
    homedir(),
    ".local",
    "state",
    "jig",
    "drive-pr",
    cloneKey(legacyDir),
  );
}

/**
 * Read-only counterpart to `defaultStateDirFor`: the resolved path if this
 * clone already has a persisted identity, or `null` if computing it would
 * require minting one (see `peekCloneKey`'s own doc for why that can't be
 * previewed). For `migrate-legacy-state.ts`'s dry-run path, which must not
 * mint durable state merely to report what `--apply` would do.
 */
export function peekDefaultStateDirFor(legacyDir: string): string | null {
  const key = peekCloneKey(legacyDir);
  return key === null
    ? null
    : join(homedir(), ".local", "state", "jig", "drive-pr", key);
}

/**
 * Read-only preview of `resolveStateDir()`'s eventual DEFAULT-path answer —
 * where state currently lives, for a caller that only needs to REPORT that,
 * never to admit itself into it. Unlike `resolveStateDir()` itself, mints no
 * clone identity, creates no directory, and writes no migration marker
 * (`reap-state.ts`'s dry-run mode, no `--delete`, was reaching
 * `ensureMigratedFromLegacy()` through the ordinary `resolveStateDir()` and
 * inheriting all three side effects on a clone with no persisted identity yet —
 * violating dry-run's own "nothing changed" contract merely by inspecting it).
 *
 * Mirrors `lease.ts`'s `resolveLegacyFallbackDir` — the identical fence-
 * fallback decision (peek the clone identity; trust the migration marker
 * unconditionally; otherwise prefer `newDir` only when `legacyDir` is
 * genuinely empty) — but omits that function's own `mkdirSync(newDir)` in
 * the empty-`legacyFootprint` branch: that call exists there only because
 * ITS caller is about to acquire a lock inside `newDir`, which a preview
 * never does. The two are siblings, not one factored into the other,
 * because they carry genuinely different contracts (lease.ts's is allowed
 * one inert directory-creation side effect for lock-acquisition
 * correctness; this one must have none at all) — a future change to the
 * shared decision shape should be applied to both.
 */
export function peekStateDir(legacyDir: string): string {
  const newDir = peekDefaultStateDirFor(legacyDir);
  if (newDir === null) return legacyDir;
  if (existsSync(migratedMarkerPath(newDir))) return resolve(newDir);
  if (legacyFootprint(legacyDir).length === 0) return newDir;
  return legacyDir;
}

/**
 * File name of the lock that excludes two drivers from one WORKING TREE. Sits
 * in `resolveStateDir` alongside the per-PR lock, so both are scoped to one
 * drive-state universe; within it, one is keyed by PR and this one by the tree
 * whose files a pass actually edits.
 *
 * Keyed by that tree's own path, and by nothing configurable. It used to be
 * derived from `dirname(handoffPath)` — which `$DRIVE_PR_HANDOFF_DIR` moves
 * — so two drivers in ONE checkout that set that variable differently, or one
 * that set it and one that did not, computed different worktree locks; their
 * per-PR locks did not collide either when they drove different PRs, so both
 * loops ran and cross-shipped each other's uncommitted edits.
 * A lock may not be keyed by a
 * location whose whole purpose is to be relocated.
 *
 * `--show-toplevel` rather than a git dir: what two drivers collide over is
 * the checked-out files, and a linked worktree has its own toplevel, which is
 * exactly the granularity wanted — Conductor worktrees are separate trees and
 * SHOULD both be able to run.
 *
 * The derivation itself lives in `actor.ts` and is SHARED with the actor id a
 * hold records, rather than duplicated here. That is not merely DRY:
 * "at most one driver per tree" is this lock's guarantee and is exactly what
 * makes a tree a sound stand-in for a driver over there. Two derivations that
 * could drift would let the two disagree about what a tree is, and the actor
 * side would be relying on a guarantee the lock had stopped providing.
 */
export async function worktreeLockName(): Promise<string> {
  return `pr-drive-worktree-${await worktreeKey()}.lock`;
}

export interface StateStore {
  readonly stateDir: string;
  readonly file: string;
  readonly lock: PathLock;
  /** Raw file text plus the validated object, or the fresh default. */
  read(): { raw: string; state: DriveState };
  /** Atomic write of `next` (no lock of its own — compose with `lock`). */
  write(next: DriveState): void;
  /** Regenerate the handoff for `next`; throws only if `rethrow` is set. */
  renderHandoff(next: DriveState, opts?: { rethrow?: boolean }): Promise<void>;
  /** acquire → read → transform → write → handoff → release, in one hold. */
  update(transform: (s: DriveState) => DriveState): Promise<void>;
  /** acquire → fn → release, for the commands with bespoke locked sections. */
  locked<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Install a check to run INSIDE every later locked section, once the lock is
   * held and before the mutation runs. Throwing from it aborts the mutation.
   *
   * This is the admission fence. A command is admitted by
   * `claimLease` and only then queues for this lock, so everything that can
   * invalidate its admission — `reset`'s sweep, an operator's `clear-lease`, a
   * dead-pid or staleness takeover — happens while it waits, in a different
   * process, with nothing to tell it. Re-checking here is the one place that
   * sees the lease as it stands at the instant the mutation is about to run.
   */
  setFence(fn: (() => void | Promise<void>) | null): void;
  /**
   * Run the installed fence explicitly. For the ONE path that takes
   * `lock.acquire()` directly instead of going through `locked()` —
   * `drive-state.ts`'s `claimFinding`, which needs bespoke handling around the
   * acquire and its own claim-file cleanup on every refusal.
   *
   * Without this that path is admitted-but-unfenced, and a claim it validates
   * after its lease was revoked goes on to dispatch a NON-idempotent summary
   * answer beside its successor's. Callers
   * must clean up before letting the refusal propagate.
   */
  runFence(): Promise<void>;
  /**
   * Register a lock the fence has ALREADY ACQUIRED, to be held through the
   * mutation `fn` runs and released immediately after — the sessionless
   * tree-lease guard (`acquireSessionlessTreeGuardNow`).
   *
   * `runFence`'s own signature (` => void | Promise<void>`) has no way to
   * express "hold this open past my own return", and that gap is exactly the
   * hole to close: a fence that only checks-then-releases still leaves the
   * window between the check and `fn` unguarded, because nothing stops a
   * DIFFERENT pr's `claimTreeLease` — which needs only ITS OWN state mutex,
   * never this one — from writing in that gap. Holding the SAME lock
   * `claimTreeLease` needs, for the whole critical section, is what actually
   * closes it. `locked` releases whatever is registered here in its own
   * `finally`, right after `fn` returns or throws; `claimFinding`, the one
   * bespoke path that does not go through `locked`, must call
   * `releaseExtraLock` itself at the exact point it releases `lock`.
   */
  setExtraLock(lock: PathLock | null): void;
  /**
   * Release + dispose whatever `setExtraLock` registered, or do nothing if
   * nothing was. Idempotent — safe to call more than once.
   */
  releaseExtraLock(): void;
}

export async function openStore(pr: string): Promise<StateStore> {
  const prNum = Number.parseInt(pr, 10);
  const stateDir = await resolveStateDir();
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, `drive-pr-${pr}.json`);

  // The orphan sweep runs once per invocation, before any command: skipped
  // when $DRIVE_PR_STATE_DIR is set (the caller named the directory, so there
  // is no migration to have missed) and when the state file exists (the
  // condition it warns about has ended). It searches `join(stateDir,
  // 'worktrees')` for the PRE-git-common-dir migration's orphans, which —
  // under the default — is a subdirectory of `~/.local/state/jig/...` that
  // never gets populated (git only ever creates a `worktrees/` folder inside
  // an actual `.git` dir), so this is now a permanent no-op except for a
  // clone still resolving `stateDir` to `--git-common-dir` itself (an
  // explicit `$DRIVE_PR_STATE_DIR` override pointed there). The later
  // migration off `--git-common-dir` has its own guard: `legacy-state.ts`'s
  // `ensureMigratedFromLegacy`, called inside `resolveStateDir()` itself.
  if (!process.env.DRIVE_PR_STATE_DIR && !existsSync(file)) {
    warnAboutOrphans(stateDir, file, pr);
  }

  const lock = createLock(file, "drive-state.ts", pr);

  function read(): { raw: string; state: DriveState } {
    if (existsSync(file)) {
      let raw = "";
      let parsed: unknown;
      let ok = false;
      try {
        raw = readFileSync(file, "utf8");
        parsed = JSON.parse(raw);
        ok = isUsableState(parsed, prNum);
      } catch {
        ok = false;
      }
      if (ok) return { raw, state: parsed as DriveState };
      // A malformed file is INDETERMINATE: leave it exactly where it is for
      // diagnosis (never truncate, never overwrite) and refuse. Recovering is
      // a human act — read the file, or `drive-state.ts reset` to abandon it
      // deliberately. See `schema.ts` for why the predicate is the shape, not
      // the syntax.
      console.error(
        `drive-state.ts: ${file} exists but is not usable drive state for PR #${pr}.`,
      );
      console.error(
        "(It must be a JSON object carrying this PR’s number plus rounds,",
      );
      console.error(
        "lastCountedHead, attempts, attemptsHead, lastReflectedRound,",
      );
      console.error(
        "lastReflectedAttempts, readyMarkedRound, ciHold, lastEscalatedRound,",
      );
      console.error(
        "lastEscalatedInvariant, verifiedSha, phase, parked, held,",
      );
      console.error(
        "roundPaths, lastProgressAt and quotaPark — ciHold is null or",
      );
      console.error(
        "a validated timeline intent/ownership record (phase, actor, createdAt,",
      );
      console.error(
        "transition ids plus head/watermark fields required by that phase); parked, held and",
      );
      console.error(
        "roundPaths must each be an ARRAY, and none of the fields is optional.",
      );
      console.error("rounds,");
      console.error("attempts, both lastReflected*, readyMarkedRound and");
      console.error(
        "lastEscalatedRound must each be a NON-NEGATIVE INTEGER, not merely a",
      );
      console.error(
        "number; lastEscalatedRound must also be no greater than rounds.",
      );
      console.error("lastCountedHead,");
      console.error("attemptsHead, verifiedSha and phase must be strings.");
      console.error(
        "lastEscalatedInvariant must also be a string — newline-free and",
      );
      console.error("length-capped, exactly what set-escalated writes.");
      console.error(
        "lastProgressAt must be '' (never) or a string Date.parse can read.",
      );
      console.error(
        "quotaPark must be null or an object carrying non-empty, newline-free",
      );
      console.error(
        "vendor and window strings, a resetAt that is null or Date.parse-able,",
      );
      console.error("and a Date.parse-able at.");
      console.error(
        "Every ROUNDPATHS entry must carry an integer round between 1 and",
      );
      console.error(
        "rounds inclusive, and a 'paths' array of strings that is already",
      );
      console.error(
        "SORTED, de-duplicated, newline-free and length-capped — exactly what",
      );
      console.error(
        "record-paths writes, so a hand-edited list is refused rather than",
      );
      console.error("compared.");
      console.error(
        "ROUNDPATHS as a WHOLE must also be strictly ascending by round (so no",
      );
      console.error(
        "duplicate round), name no round beyond this state’s own rounds, and",
      );
      console.error(
        "carry no entry outside the retained window whose round is already",
      );
      console.error("acknowledged (round <= lastEscalatedRound).");
      console.error(
        "Every PARKED entry must carry a non-empty newline-free key, a kind of",
      );
      console.error(
        "thread|finding, a NON-EMPTY reason, and a non-negative integer round.",
      );
      console.error(
        "Every HELD entry must carry a non-empty newline-free key, a kind of",
      );
      console.error(
        "thread|finding, an outcome of accepted|moot, an integer round no",
      );
      console.error(
        "lower than -1 (-1 is the sentinel hold --unconfirmed writes), and an",
      );
      console.error(
        "'actor' matching the exact grammar resolveActor() emits — 'wt-' plus",
      );
      console.error(
        "16 lowercase hex digits (the tree that made its promise).",
      );
      console.error(
        "A held THREAD must also carry a non-empty commentUrl; a held FINDING",
      );
      console.error(
        "a non-empty reason. A held verifiedSha is optional (absent until the",
      );
      console.error(
        "holding actor pushes) but, when present, must be a full 40-character",
      );
      console.error("lowercase hex SHA. Valid JSON is not");
      console.error(
        "enough. This list is exhaustive on purpose: it is the only thing that",
      );
      console.error(
        "tells a reader WHICH field is missing, and a file whose key/kind/round",
      );
      console.error(
        "all look fine is exactly the one they cannot diagnose without it. It",
      );
      console.error(
        "A file written before one of those fields existed lands here by design:",
      );
      console.error(
        "BWC is deferred pre-GA, so it is refused rather than read through a",
      );
      console.error("dual-shape path.");
      console.error(
        "Refusing to treat it as a fresh drive: that would discard the parked",
      );
      console.error(
        "decisions and durable round budget this file exists to preserve.",
      );
      console.error(
        `Inspect it, or run 'drive-state.ts reset ${pr}' to abandon it deliberately.`,
      );
      throw new ExitError(3);
    }
    const fresh = freshState(prNum);
    return { raw: `${JSON.stringify(fresh, null, 2)}\n`, state: fresh };
  }

  function write(next: DriveState): void {
    atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`);
  }

  async function renderHandoffFor(
    next: DriveState,
    opts: { rethrow?: boolean } = {},
  ): Promise<void> {
    try {
      await renderHandoff(pr, next);
    } catch (e) {
      if (opts.rethrow) throw e;
      // Best-effort by design: the handoff is an orientation artefact
      // (`handoff.ts` header), and a rendering failure must never turn a
      // state mutation that already landed into a reported failure.
    }
  }

  // Test-only concurrency hook for ANY locked section, unset (no-op) by
  // default — the sibling of `claim-held`'s DRIVE_PR_CLAIM_HELD_TEST_* pair,
  // and live in the shipped script for the same reason: proving lock-instance
  // semantics (a suspended holder must not release a lock a stale-breaker
  // replaced; a concurrent claimant must see a fresh record only AFTER a
  // `hold` finishes replacing it, never mid-replacement) needs a way to HOLD
  // the lock open deterministically while a test races another call in — the
  // bash suite got that window by shimming `mv` on PATH, which a
  // `renameSync` port cannot be stalled by. Lives on `locked` itself, not
  // `update`, so every locked section gets it — `hold`'s finding branch
  // needs the exact same deterministic window `update`'s
  // callers already had, and a second, differently-named hook per caller
  // would just be this one duplicated. `testDelaySeconds` owns the validation
  // and the hard cap every one of these hooks shares.
  async function testWriteStall(): Promise<void> {
    const delaySec = testDelaySeconds("DRIVE_PR_UPDATE_TEST_DELAY", "update");
    const signal = process.env.DRIVE_PR_UPDATE_TEST_SIGNAL;
    if (signal) writeFileSync(signal, "");
    if (delaySec > 0) await sleep(delaySec);
  }

  let fence: (() => void | Promise<void>) | null = null;
  function setFence(fn: (() => void | Promise<void>) | null): void {
    fence = fn;
  }
  async function runFence(): Promise<void> {
    if (fence) await fence();
  }

  let extraLock: PathLock | null = null;
  function setExtraLock(l: PathLock | null): void {
    extraLock = l;
  }
  function releaseExtraLock(): void {
    if (extraLock) {
      extraLock.release();
      extraLock.dispose();
      extraLock = null;
    }
  }

  async function locked<T>(fn: () => Promise<T>): Promise<T> {
    await lock.acquire();
    try {
      await testWriteStall();
      // AFTER the stall, not before: the stall is how the tests hold this
      // section open to race a takeover in, and a fence that ran ahead of it
      // would check the lease at a moment no takeover could yet have happened
      // — passing every time, and testing nothing.
      await runFence();
      try {
        return await fn();
      } finally {
        // Whatever the fence registered via `setExtraLock` (the sessionless
        // tree guard) is held THROUGH `fn()` and released here,
        // immediately after — never earlier, or the window it exists to
        // close reopens between the check and the mutation it guards.
        releaseExtraLock();
      }
    } finally {
      lock.release();
    }
  }

  // Read → transform → replace, with the read fully materialised before the
  // write begins, and every write through a temp file in the same directory:
  // a torn state file would make a resumed drive silently forget which
  // threads are parked, reopening precisely the loop this store exists to
  // close. The handoff regenerates INSIDE this same lock hold, on the state
  // this call just wrote — one acquisition covers both artefacts (see
  // `handoff.ts` for why a second acquisition would be worse than none).
  async function update(
    transform: (s: DriveState) => DriveState,
  ): Promise<void> {
    await locked(async () => {
      const { state } = read();
      const next = transform(state);
      write(next);
      // Best-effort, NOT rethrowing. `write` has already completed, so the
      // mutation is durable by the time the handoff runs; rethrowing here
      // returned non-zero for a state change that succeeded, and a caller
      // reading that as failure re-ran the command — replaying a NON-idempotent
      // mutation such as `bump-attempt` and burning another attempt against the
      // round bound. The handoff is an
      // orientation aid this skill explicitly declines to treat as a
      // transactional mirror of the state (SKILL.md § Handing off), so it is
      // the one artefact whose failure must not invalidate the write.
      await renderHandoffFor(next);
    });
  }

  return {
    stateDir,
    file,
    lock,
    read,
    write,
    renderHandoff: renderHandoffFor,
    update,
    locked,
    setFence,
    runFence,
    setExtraLock,
    releaseExtraLock,
  };
}

/**
 * The durable per-PR state store: where a clone's state lives, how a PR's
 * state is read (fail-closed), and how it is written (under the store's
 * lock, with the handoff regenerated in the same hold).
 *
 * The state is a row of the drive's database (`db.ts`), one per clone and
 * pull request, holding the `DriveState` document as JSON with its schema
 * version. The database is one file per machine,
 * `~/.local/state/jig/drive-pr/state.sqlite`; `$DRIVE_PR_STATE_DIR`, an
 * absolute path, moves the root it and every clone's directory live under.
 * A clone's directory, `<root>/<clone key>/`, keeps the files beside the
 * database (the driver log, the kept answers, the arm output), and a function
 * handed it reaches the database beside it. `await-round.ts` keeps its
 * separate review-round counter in the worktree's Git directory.
 *
 * An inherited resolved clone directory is idempotent: a driver exports its
 * own as `$DRIVE_PR_STATE_DIR`, and a path whose last component is this
 * clone's key is not nested again. A root that holds a drive's files
 * directly, from a release that kept them there, is refused rather than
 * adopted: those files carry no repository, so whose they are is unknown.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { ExitError, fail, sleep, testDelaySeconds } from "../cli.ts";
import { git, gitCallTimeoutSeconds, gitIdentityEnv } from "../proc.ts";
import { worktreeKey } from "./actor.ts";
import { isCloneFile } from "./artifacts.ts";
import { cloneKey, peekCloneKey } from "./clone-key.ts";
import { driveDb } from "./db.ts";
import { renderHandoff } from "./handoff.ts";
import { isFormerFile } from "./import.ts";
import { createLock, type PathLock } from "./lock.ts";
import { type DriveState, freshState, isUsableState } from "./schema.ts";

/** The version of the `DriveState` document a row's `v` column says it was written in. */
export const DRIVE_STATE_VERSION = 1;

/**
 * `$DRIVE_PR_STATE_DIR`, validated and absolute, or `null` when it is unset.
 * A relative override would resolve against each participant's own working
 * directory, so two participants launched from different trees would
 * silently use two different state roots: it is refused instead.
 */
function resolvedOverride(): string | null {
  const override = process.env.DRIVE_PR_STATE_DIR ?? "";
  if (override === "") return null;
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
  return resolve(override);
}

/** The directory the database and every clone's directory are under, by default. */
export function defaultStateRoot(): string {
  return join(homedir(), ".local", "state", "jig", "drive-pr");
}

/**
 * The clone's directory under `root` for clone key `key`, refusing a root
 * that holds a drive's files directly (see the header).
 */
function cloneDirUnder(root: string, key: string, commonDir: string): string {
  if (basename(root) === key) return root;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    names = [];
  }
  const flat = names.find((name) => isFormerFile(name) || isCloneFile(name));
  if (flat !== undefined) {
    fail(
      2,
      `drive-state.ts: unscoped state artifact at ${join(root, flat)}`,
      `Current clone: ${commonDir}; legacy repository: unknown (the old format has no repository binding).`,
      `Expected clone directory: ${join(root, key)}`,
      "Refusing to adopt or bypass this history. Stop all participants and explicitly",
      "identify and relocate the legacy artifacts before using this override root.",
      "No existing state has been moved or rewritten. See README: Relocating the state dir.",
    );
  }
  return join(root, key);
}

/** This clone's state directory, minting the clone's identity when it has none. */
export async function resolveStateDir(): Promise<string> {
  const root = resolvedOverride() ?? defaultStateRoot();
  const commonDir = await resolveCommonDir();
  return cloneDirUnder(root, cloneKey(commonDir), commonDir);
}

/**
 * This clone's state directory without minting an identity: `null` when the
 * clone has none yet, so it can have no state. For a caller that only
 * reports (the drive listing, a SessionStart banner, a dry run).
 */
export async function peekResolvedStateDir(): Promise<string | null> {
  const root = resolvedOverride() ?? defaultStateRoot();
  const commonDir = await resolveCommonDir();
  const key = peekCloneKey(commonDir);
  return key === null ? null : cloneDirUnder(root, key, commonDir);
}

/**
 * This clone's Git common directory, absolute: the input to its clone key.
 * Deadlined, and scrubbed of `GIT_DIR` and `GIT_WORK_TREE`, which a
 * hook-launched driver may inherit for another checkout. A pass that changed
 * its shell's directory still belongs to the tree its driver pinned
 * (`$DRIVE_PR_WORKTREE`).
 */
export async function resolveCommonDir(): Promise<string> {
  const cwd = process.env.DRIVE_PR_WORKTREE || process.cwd();
  const r = await git(["rev-parse", "--git-common-dir"], {
    cwd,
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
    env: gitIdentityEnv(),
  });
  const commonDir = r.code === 0 ? resolve(cwd, r.stdout.trim()) : "";
  if (commonDir === "") {
    fail(
      2,
      "drive-state.ts: no state dir (cannot resolve this clone's Git common directory).",
      "A state-root override still requires this clone identity.",
    );
  }
  return commonDir;
}

/**
 * The name of the lock that excludes two drivers from one WORKING TREE,
 * keyed by that tree's own path (`actor.ts`'s `worktreeKey`) and by nothing
 * configurable: a lock keyed by a location meant to be relocated lets two
 * drivers in one checkout compute two different locks.
 */
export async function worktreeLockName(): Promise<string> {
  return `pr-drive-worktree-${await worktreeKey()}`;
}

/** A pull request's number as the database keys it: canonical decimal digits. */
export function canonicalPr(pr: string): string {
  return /^[0-9]+$/.test(pr) ? BigInt(pr).toString() : pr;
}

/** A PR's stored state row, as the store reads it. */
interface StateRow {
  v: number;
  state: string;
  updated_at: string;
}

/** The stored text of a PR's state in a clone, and when it was written; `null` when it has none. */
export function readStateRow(
  stateDir: string,
  pr: string,
): { text: string; v: number; at: string } | null {
  const drive = driveDb(stateDir);
  const row = drive.db
    .query(
      "SELECT v, state, updated_at FROM drive_state WHERE clone = ? AND pr = ?",
    )
    .get(drive.clone, canonicalPr(pr)) as StateRow | null;
  return row === null
    ? null
    : { text: row.state, v: row.v, at: row.updated_at };
}

/** Every PR's stored state in a clone. */
export function stateRows(
  stateDir: string,
): { pr: string; text: string; v: number; at: string }[] {
  const drive = driveDb(stateDir);
  return (
    drive.db
      .query(
        "SELECT pr, v, state, updated_at FROM drive_state WHERE clone = ? ORDER BY CAST(pr AS INTEGER)",
      )
      .all(drive.clone) as (StateRow & { pr: string })[]
  ).map((r) => ({ pr: r.pr, text: r.state, v: r.v, at: r.updated_at }));
}

/** Write a PR's state text in a clone as it is, unvalidated: the store's write, and a test fixture's. */
export function writeStateRow(
  stateDir: string,
  pr: string,
  text: string,
): void {
  const drive = driveDb(stateDir);
  drive.db.run(
    `INSERT INTO drive_state (clone, pr, v, state, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (clone, pr) DO UPDATE SET v = excluded.v, state = excluded.state, updated_at = excluded.updated_at`,
    [
      drive.clone,
      canonicalPr(pr),
      DRIVE_STATE_VERSION,
      text,
      new Date().toISOString(),
    ],
  );
}

/** Remove a PR's state in a clone. */
export function removeStateRow(stateDir: string, pr: string): void {
  const drive = driveDb(stateDir);
  drive.db.run("DELETE FROM drive_state WHERE clone = ? AND pr = ?", [
    drive.clone,
    canonicalPr(pr),
  ]);
}

export interface StateStore {
  readonly stateDir: string;
  /** Where this PR's state lives, for a message a person reads. */
  readonly where: string;
  readonly lock: PathLock;
  /** The stored text plus the validated object, or the fresh default. */
  read(): { raw: string; state: DriveState };
  /** The stored text, unvalidated, or `null` when this PR has no state. */
  stored(): string | null;
  /** Write `next` (no lock of its own: compose with `lock`). */
  write(next: DriveState): void;
  /** Remove this PR's state (no lock of its own). */
  remove(): void;
  /** Regenerate the handoff for `next`; throws only if `rethrow` is set. */
  renderHandoff(next: DriveState, opts?: { rethrow?: boolean }): Promise<void>;
  /** acquire → read → transform → write → handoff → release, in one hold. */
  update(transform: (s: DriveState) => DriveState): Promise<void>;
  /** acquire → fn → release, for the commands with bespoke locked sections. */
  locked<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Install a check to run INSIDE every later locked section, once the lock
   * is held and before the mutation runs; throwing from it aborts the
   * mutation. This is the admission fence: a command is admitted by
   * `claimLease` and only then queues for this lock, so anything that
   * invalidates its admission while it waits (a `reset`, a `clear-lease`, a
   * takeover) is seen here, at the instant the mutation is about to run.
   */
  setFence(fn: (() => void | Promise<void>) | null): void;
  /** Run the installed fence, for the one path that takes `lock` directly. */
  runFence(): Promise<void>;
  /**
   * Register a lock the fence has already taken (the tree-lease guard), held
   * through the mutation `fn` runs and released right after it: `locked`
   * releases it in its own `finally`; a path that takes `lock` directly
   * calls `releaseExtraLock` where it releases `lock`.
   */
  setExtraLock(lock: PathLock | null): void;
  /** Release whatever `setExtraLock` registered. Idempotent. */
  releaseExtraLock(): void;
}

/** The message lines for a stored state the store cannot use. */
function refuseUnusable(
  where: string,
  pr: string,
  newer: number | null,
): never {
  console.error(
    `drive-state.ts: ${where} exists but is not usable drive state for PR #${pr}.`,
  );
  if (newer !== null) {
    console.error(
      `It was written in drive state version ${newer}, which a newer plugin wrote; this plugin reads version ${DRIVE_STATE_VERSION}. Update the plugin.`,
    );
  } else {
    console.error(
      "(It must be a JSON object carrying this PR's number plus rounds,",
      "lastCountedHead, attempts, attemptsHead, lastReflectedRound,",
      "lastReflectedAttempts, readyMarkedRound, ciHold, lastEscalatedRound,",
      "lastEscalatedInvariant, verifiedSha, phase, parked, held,",
      "roundPaths, lastProgressAt and quotaPark: ciHold is null or a",
      "validated timeline intent/ownership record (phase, actor, createdAt,",
      "transition ids plus the head and watermark fields its phase needs);",
      "parked, held and roundPaths must each be an ARRAY, and none of these",
      "fields is optional.",
      "rounds, attempts, both lastReflected*, readyMarkedRound and",
      "lastEscalatedRound must each be a NON-NEGATIVE INTEGER, not merely a",
      "number; lastEscalatedRound must also be no greater than rounds.",
      "lastCountedHead, attemptsHead, verifiedSha and phase must be strings.",
      "lastEscalatedInvariant must also be a string: newline-free and",
      "length-capped, exactly what set-escalated writes.",
      "lastProgressAt must be '' (never) or a string Date.parse can read.",
      "quotaPark must be null or an object carrying non-empty, newline-free",
      "vendor and window strings, a resetAt that is null or Date.parse-able,",
      "and a Date.parse-able at.",
      "Every ROUNDPATHS entry must carry an integer round between 1 and",
      "rounds inclusive, and a 'paths' array of strings that is already",
      "SORTED, de-duplicated, newline-free and length-capped, exactly what",
      "record-paths writes, so a hand-edited list is refused rather than",
      "compared. ROUNDPATHS as a WHOLE must also be strictly ascending by",
      "round (so no duplicate round), name no round beyond this state's own",
      "rounds, and carry no entry outside the retained window whose round is",
      "already acknowledged (round <= lastEscalatedRound).",
      "Every PARKED entry must carry a non-empty newline-free key, a kind of",
      "thread|finding, a NON-EMPTY reason, and a non-negative integer round.",
      "Every HELD entry must carry a non-empty newline-free key, a kind of",
      "thread|finding, an outcome of accepted|moot, an integer round no",
      "lower than -1 (-1 is the sentinel hold --unconfirmed writes), and an",
      "'actor' matching the exact grammar resolveActor() emits: 'wt-' plus",
      "16 lowercase hex digits (the tree that made its promise).",
      "A held THREAD must also carry a non-empty commentUrl; a held FINDING",
      "a non-empty reason. A held verifiedSha is optional (absent until the",
      "holding actor pushes) but, when present, must be a full 40-character",
      "lowercase hex SHA.)",
      "Valid JSON is not enough. This list is exhaustive on purpose: it is",
      "the only thing that tells a reader WHICH field is missing.",
    );
  }
  console.error(
    "Refusing to treat it as a fresh drive: that would discard the parked",
    "decisions and durable round budget this state exists to preserve.",
    `Inspect it with 'drive-state.ts get ${pr}', or run 'drive-state.ts reset ${pr}' to abandon it deliberately.`,
  );
  throw new ExitError(3);
}

export async function openStore(pr: string): Promise<StateStore> {
  const prNum = Number.parseInt(pr, 10);
  const stateDir = await resolveStateDir();
  // The clone's directory holds the files beside the database (the kept
  // answers, the long pass notice), which a command may write next.
  mkdirSync(stateDir, { recursive: true });
  const drive = driveDb(stateDir);
  const where = `the drive state of PR #${canonicalPr(pr)} in ${drive.path}`;
  const lock = createLock(
    stateDir,
    `drive-pr-${canonicalPr(pr)}`,
    "drive-state.ts",
    pr,
  );

  function stored(): string | null {
    return readStateRow(stateDir, pr)?.text ?? null;
  }

  function read(): { raw: string; state: DriveState } {
    const row = readStateRow(stateDir, pr);
    if (row === null) {
      const fresh = freshState(prNum);
      return { raw: `${JSON.stringify(fresh, null, 2)}\n`, state: fresh };
    }
    if (row.v > DRIVE_STATE_VERSION) refuseUnusable(where, pr, row.v);
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.text);
    } catch {
      refuseUnusable(where, pr, null);
    }
    if (!isUsableState(parsed, prNum)) refuseUnusable(where, pr, null);
    return { raw: row.text, state: parsed };
  }

  function write(next: DriveState): void {
    writeStateRow(stateDir, pr, `${JSON.stringify(next, null, 2)}\n`);
  }

  function remove(): void {
    removeStateRow(stateDir, pr);
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
      // (`handoff.ts`), and a rendering failure must never turn a state
      // mutation that already landed into a reported failure.
    }
  }

  // A test seam: hold any locked section open deterministically while a
  // test races another call into it (`DRIVE_PR_UPDATE_TEST_DELAY`, its
  // signal file written first). `testDelaySeconds` validates and caps it.
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
      // After the stall: a fence that ran ahead of it would check the lease
      // before any takeover the test races in could have happened.
      await runFence();
      try {
        return await fn();
      } finally {
        releaseExtraLock();
      }
    } finally {
      lock.release();
    }
  }

  // Read, transform and write in one hold of the lock, with the handoff
  // regenerated inside the same hold on the state just written. The handoff
  // is best-effort: the write is durable by then, and reporting a failure
  // for a mutation that landed would make a caller replay a non-idempotent
  // one such as `bump-attempt`.
  async function update(
    transform: (s: DriveState) => DriveState,
  ): Promise<void> {
    await locked(async () => {
      const { state } = read();
      const next = transform(state);
      write(next);
      await renderHandoffFor(next);
    });
  }

  return {
    stateDir,
    where,
    lock,
    read,
    stored,
    write,
    remove,
    renderHandoff: renderHandoffFor,
    update,
    locked,
    setFence,
    runFence,
    setExtraLock,
    releaseExtraLock,
  };
}

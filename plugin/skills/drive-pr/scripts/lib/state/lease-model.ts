/**
 * The session lease's model: its records, where they live, who "a session"
 * is, and the timing every admission and fence shares.
 *
 * Two records, both rows of the drive's database (`db.ts`):
 *
 * - the per-PR lease (`leases`), one per (clone, PR, working tree): which
 *   session drives this PR from this tree. At most one live session per
 *   tree and PR, and at most one tree per PR;
 * - the tree lease (`tree_leases`), one per (clone, working tree): which
 *   session works this tree, whichever PR, so two sessions driving two
 *   different PRs cannot both edit one checkout.
 *
 * Each carries the holder's process identity (`shared/liveness.ts`'s
 * `ProcessIdentity`: host id, host name, boot id, pid and start time), so
 * whether the holder still runs is judged the way every other lock and claim
 * in the plugin judges it, and the lease shape that module defines: a
 * generation, when it was taken, when it was last renewed and when it
 * expires. The generation is drawn from a counter that only grows
 * (`db.ts`'s `nextCount`): kept across one session's renewals, and raised by
 * every new admission and takeover, so a command admitted on one generation
 * can tell, at the moment it mutates, that its lease was cleared or taken
 * over while it waited (`assertLeaseUnchanged`, through `liveness.ts`'s
 * `fence`).
 *
 * Why a lease and not a lock: there is no long-lived process behind a
 * `drive-state.ts` invocation to hold a lock, so the session renews its
 * lease on every mutating command, and a lease nobody renews expires.
 */
import { hostname } from "node:os";
import { SESSION_LEASE_MIN } from "../../../../../shared/liveness.ts";
import { fail, isDigits } from "../cli.ts";
import { pidAlive } from "../proc.ts";
import { outOfBandExitCode } from "../status/terminal-states.ts";
import { createLock, LOCK_ACQUIRE_MAX_SEC } from "./lock.ts";

/** A session lease as the drive reads it. Every field is required. */
export interface Lease {
  /**
   * WHO holds it, and therefore how its liveness may be tested:
   *
   * - `session`: a pid holds it, so liveness is the pid's (judged by its
   *   recorded identity) AND a renewal inside the window;
   * - `worktree`: the presence record a sessionless resolver writes (ladder
   *   tier 3). No session could be identified, so the WORKING TREE is the
   *   holder and freshness is the only liveness it has; its pid is `0`.
   */
  holder: "session" | "worktree";
  /** The session's pid; `0` for a `worktree` holder. */
  pid: number;
  /** Where that pid lives: its host name, for a person and for a record without a host id. */
  host: string;
  /** The host's stable id (`liveness.ts`'s `thisHost`); empty when it could not be read. */
  hostId: string;
  /** The host's boot id; empty where the platform has none. */
  bootId: string;
  /** The session's start time as the process table reports it; empty when it could not be read. */
  start: string;
  /** `process.platform` of the session that wrote it, so a refusal can name a check that host can run. */
  platform: string;
  /** The working tree it is scoped to (`actor.ts`'s id). */
  actor: string;
  /** That tree's path, for a refusal a person must act on; never compared. */
  worktree: string;
  /** When this session first took it. */
  startedAt: string;
  /** When it last ran a mutating command: the renewal this lease lives by. */
  lastSeen: string;
  /** When it expires unless renewed, by the window of the session that renewed it last. */
  expiresAt: string;
  /** Which command renewed it last. Diagnostics only. */
  command: string;
  /** The admission generation: kept across renewals, raised by every new admission or takeover. */
  generation: number;
  /**
   * The writing session's own acquisition token
   * (`$DRIVE_PR_SESSION_STARTED`, minted once by `drive.ts` and inherited by
   * every pass it spawns), or `''` when it carries none: what tells a
   * recycled pid apart from the session that once had it (`isMine`).
   */
  sessionStarted: string;
}

/** The tree lease: a `Lease` plus the PR the tree currently drives and a token fresh on every write. */
export interface TreeLease extends Lease {
  /** The PR this session is currently, or most recently, driving: diagnostics only. */
  pr: string;
  /**
   * A token minted on every write, never kept across a renewal, so a
   * rollback can tell the write it made from a later one that happened to
   * carry the same fields (`rollbackTreeLease`).
   */
  revision: string;
}

export interface Session {
  pid: number;
  host: string;
  /** Which tier of the ladder answered. */
  source: "DRIVE_PR_SESSION" | "CLAUDE_PID" | "none";
  /**
   * This session's own `$DRIVE_PR_SESSION_STARTED`, or `''`. Read only for
   * the `DRIVE_PR_SESSION` tier: for a `CLAUDE_PID` session it could be a
   * value left in the shell by an unrelated earlier `drive.ts` run.
   */
  sessionStarted: string;
}

/** A per-PR lease's place: the clone's state directory, the PR and the tree. */
export interface LeaseRef {
  readonly stateDir: string;
  /** The PR, canonical. */
  readonly pr: string;
  readonly actor: string;
}

/** A tree lease's place: the clone's state directory and the tree. */
export interface TreeLeaseRef {
  readonly stateDir: string;
  readonly actor: string;
}

/**
 * The ONE spelling of a PR used to key a lease, for readers and writers
 * alike: `0999` and `999` are the same PR, and a writer and a fence that
 * spelled it differently would miss each other's lease. `BigInt`, since
 * `Number` is lossy past `MAX_SAFE_INTEGER`. A non-digit string passes
 * through untouched; every caller validates with `isDigits` first.
 */
export function canonicalLeasePr(pr: string): string {
  return isDigits(pr) ? BigInt(pr).toString() : pr;
}

/** The per-PR lease of one (working tree, PR) pair in a clone. */
export function leaseRef(
  stateDir: string,
  pr: string,
  actor: string,
): LeaseRef {
  return { stateDir, pr: canonicalLeasePr(pr), actor };
}

/** The tree lease of one working tree in a clone. */
export function treeLeaseRef(stateDir: string, actor: string): TreeLeaseRef {
  return { stateDir, actor };
}

/** A lease's place as a person reads it. */
export function leaseLabel(ref: LeaseRef | TreeLeaseRef): string {
  return "pr" in ref
    ? `the session lease of PR #${ref.pr} for ${ref.actor}`
    : `the tree lease of ${ref.actor}`;
}

/** The name of the PR-wide remote-mutation lock: one per PR, contended by every tree driving it. */
export function remoteLockName(pr: string): string {
  return `drive-pr-remote-lock-${canonicalLeasePr(pr)}`;
}

/** The name of a tree lease's own lock, which the tree guards hold through a mutation. */
export function treeLeaseLockName(actor: string): string {
  return `drive-tree-lease-${actor}`;
}

/**
 * The tree lease's own lock: claiming the tree lease, and every guard that
 * must hold the tree through a mutation (`acquireIdentifiedTreeGuardNow`,
 * `acquireSessionlessTreeGuardNow`, `assertTreeMutationAllowed`), take it,
 * so a takeover cannot land between the check and the mutation.
 */
export function treeLeaseLock(stateDir: string, actor: string) {
  return createLock(
    stateDir,
    treeLeaseLockName(actor),
    "drive-state.ts (tree lease)",
    "tree",
  );
}

/**
 * The PR-wide remote-mutation lock: at most one irreversible remote
 * mutation (a `guarded-push.ts` push, an `answer-summary-finding.ts` post)
 * per PR at a time, whichever tree makes it, and no new tree admitted to the
 * PR while one is in flight.
 *
 * Lock order, the same for every caller that holds more than one:
 *
 *   `claimLease` (a takeover or a renewal past the margin):
 *     remote-mutation lock → the store's per-PR lock → the lease row
 *   `guarded-push.ts`, `answer-summary-finding.ts`:
 *     remote-mutation lock → tree-lease lock
 *
 * Nothing takes the remote-mutation lock after the tree-lease lock, so no two
 * callers can wait on each other in a cycle.
 */
export function prRemoteMutationLock(stateDir: string, pr: string) {
  return createLock(
    stateDir,
    remoteLockName(pr),
    "drive-state.ts (pr remote mutation)",
    pr,
  );
}

/**
 * How long a lease whose holder still runs may go un-renewed before it
 * counts as abandoned, by default the shared session lease
 * (`SESSION_LEASE_MIN`). Generous on purpose: renewal is driven by the work,
 * and an agent may think or wait on a test machine for a long time between
 * two mutating calls. Too eager costs two concurrent drivers; too slow costs
 * a refusal a person clears in one command.
 */
const LEASE_STALE_MIN_DEFAULT = SESSION_LEASE_MIN;

/** The renewal cap in `renewAfterMs`: the oldest a lease can be on admission. */
const RENEW_AFTER_MAX_MS = 30_000;

/**
 * The smallest staleness window that cannot expire a lease out from under a
 * command already admitted: at most `RENEW_AFTER_MAX_MS` old when admitted,
 * then waiting at most `LOCK_ACQUIRE_MAX_SEC` for the store's lock. A
 * concurrent `reset` that read it as expired in that gap would sweep a lease
 * whose command has not run yet.
 */
function leaseStaleFloorMs(): number {
  return LOCK_ACQUIRE_MAX_SEC * 1000 + RENEW_AFTER_MAX_MS;
}

export function leaseStaleMs(): number {
  const raw = process.env.DRIVE_PR_LEASE_STALE_MIN ?? "";
  const n = isDigits(raw) ? Number.parseInt(raw, 10) : LEASE_STALE_MIN_DEFAULT;
  return Math.max(
    Math.min(Math.max(n, 1), 10_080) * 60_000,
    leaseStaleFloorMs(),
  );
}

/** The staleness window in minutes, named in every refusal that depends on it. */
export function leaseStaleMin(): number {
  return Math.round(leaseStaleMs() / 60_000);
}

/**
 * How long a lease this session already holds may go un-rewritten before the
 * next mutating command renews it: a quarter of the window, capped.
 */
export function renewAfterMs(): number {
  return Math.min(RENEW_AFTER_MAX_MS, Math.floor(leaseStaleMs() / 4));
}

/**
 * A pid, or `null` when `raw` is not one: `0`, and digit strings too long to
 * be exact, are not pids, and a lease under one would exclude nobody.
 */
function parsePid(raw: string): number | null {
  if (!isDigits(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * This invocation's session, by a ladder:
 *
 * 1. `$DRIVE_PR_SESSION`: the driver's pid, exported to its passes. A value
 *    that is not a live pid is refused, since the caller named this session
 *    deliberately and a silent fallback would be another identity.
 * 2. `$CLAUDE_PID`: the agent harness's process, when it is alive.
 * 3. none: no lease identity; the sessionless path writes a presence record
 *    held by the working tree.
 *
 * `label` names the script in the refusals, since the external-mutation
 * fence resolves the session from other scripts too.
 */
export function resolveSession(label = "drive-state.ts"): Session {
  const explicit = process.env.DRIVE_PR_SESSION ?? "";
  const explicitPid = parsePid(explicit);
  if (explicitPid !== null) {
    if (!pidAlive(explicitPid, hostname())) {
      fail(
        2,
        `${label}: $DRIVE_PR_SESSION names pid ${explicitPid}, which is not running.`,
        "A lease taken under a dead pid is abandoned the instant it is written —",
        "any other session may take it over — so admitting one would report an",
        "exclusion that does not exist.",
        "",
        "This usually means the driver that exported it has exited while this",
        "process outlived it. Stop this pass rather than letting it work beside",
        "its replacement; unset the variable only if you mean to run without a",
        "session identity at all.",
      );
    }
    return {
      pid: explicitPid,
      host: hostname(),
      source: "DRIVE_PR_SESSION",
      sessionStarted: process.env.DRIVE_PR_SESSION_STARTED ?? "",
    };
  }
  if (explicit !== "") {
    fail(
      2,
      `${label}: $DRIVE_PR_SESSION must be a process id — a positive integer small enough to be exact (got '${explicit}').`,
      "It names the long-lived process whose liveness this session is judged by —",
      "drive.ts exports its own pid here. Unset it to fall back to the harness's",
      "agent process.",
    );
  }
  const agentPid = parsePid(process.env.CLAUDE_PID ?? "");
  if (agentPid !== null && pidAlive(agentPid, hostname())) {
    return {
      pid: agentPid,
      host: hostname(),
      source: "CLAUDE_PID",
      sessionStarted: "",
    };
  }
  return { pid: 0, host: hostname(), source: "none", sessionStarted: "" };
}

/**
 * The exit every PER-TREE lease refusal uses: another live SESSION in THIS
 * working tree holds the lease, and `clear-lease`, which the reader can run
 * where they stand, is the remedy. Bound to `TERMINAL_STATES`.
 */
export const SESSION_LEASE_HELD_EXIT = outOfBandExitCode("SESSION_LEASE_HELD");

/**
 * The exit a PR-WIDE refusal carries: another WORKING TREE drives this PR,
 * and the reader is very likely not the person who should clear it.
 */
export const DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode(
  "DRIVE_HELD_BY_OTHER_WORKTREE",
);

/**
 * What `claimLease` grants: the per-PR lease and the tree lease together,
 * both or neither. Neither only when a sessionless resolver finds its tree's
 * own per-PR lease held by a live identified session and defers to it.
 */
export type LeaseAdmission =
  | { lease: Lease; treeLease: TreeLease }
  | { lease: null; treeLease: null };

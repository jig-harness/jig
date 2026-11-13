/**
 * The single, code-bound source of truth for the drive's terminal-state
 * vocabulary — which `state` name pairs with which exit code, what kind of
 * pairing it is, and what each one means to a reader that branches on it.
 *
 * Without this table the pairing exists nowhere as data: `evaluate.ts` would
 * set `report.state` and return an exit code independently at each of its
 * sites, and the prose restatements — `drive-status.ts`'s "Exit codes" doc
 * comment, `SKILL.md` § Terminal states and `references/terminal-states.md`
 * § Exit codes — would each hand-copy the pairing with nothing keeping them
 * in step. Hand-counted tallies drift, so this comment gives none: see
 * `__tests__/terminal-states-consistency.ts`'s `CORPUS_FILES` for the
 * restatements it checks, and `evaluate.ts` itself for its sites.
 *
 * `evaluate.ts` threads every one of its `report.state`/exit-code sites
 * through `terminal` below, so a wrong pairing there is a type error or a
 * thrown assertion, never a silent typo. The consistency check re-derives the
 * emitted set from THIS table and scans the prose restatements for a
 * documented (exit, state) pair this table does not contain — a drift check
 * that commits nothing.
 *
 * The Jig Protocol's chapter on the drive's end states and exit codes
 * (`plugin/protocol/drive-exits.md`, and its data file beside it) is
 * generated from this table, `meaning` included, by
 * `tools/protocol/generate.ts`; `bun run gates` fails the build when the
 * chapter and this table disagree.
 *
 * The dispatcher names no exit code of its own: it reads `drive.ts`'s exits
 * through `DRIVE_EXIT` and the sets below it (`DRIVER_REFUSAL_EXITS`,
 * `PERSON_STOP_EXITS`, `driveExitClosesTab`), and the consistency check fails a
 * dispatcher file that restates one as a number
 * (`__tests__/terminal-states-dispatch.ts`).
 *
 * Categories of entry (`drive-status.ts`'s "Exit codes — the driver contract"
 * doc comment mixes the first four in one column, unmarked):
 *
 *   'state'        a real `state` value the `--json` report can carry.
 *   'class-label'  a name for a FAMILY of states sharing one exit code,
 *                  never itself emitted (`NOT_SETTLED` for exit `4`).
 *   'tombstone'    a withdrawn code, deliberately never re-emitted
 *                  (`RETIRED`, exit `10`, was `PR_IS_DRAFT`).
 *   'driver-only'  a `drive.ts`-only exit that produces no `--json` report
 *                  at all (`PASS_DEADLINE`, `QUOTA_PARKED`, and the unnamed
 *                  codes `drive.ts` returns directly).
 *   'helper'       an exit in this numbering that one of the drive's helper
 *                  scripts returns, never `drive-status.ts` or `drive.ts`
 *                  (`PUSH_HELD`, exit `17`, from `guarded-push.ts`); listed
 *                  so that no code looks free while it is in use.
 *
 * `evaluate.ts`'s own 'state' entries are bound in code (the
 * `EvaluateStateName` union below, consumed by `terminal`): every site in
 * `evaluate.ts` sets both through it. Every 'driver-only' entry is bound the
 * OTHER direction: `lib/driver/settings.ts` exports a named constant for each
 * (`MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS')`, and so on for every
 * member of `DriverOnlyStateName`), `drive.ts` re-exports them, and every one
 * of `drive.ts`'s own `return` sites for these codes uses the constant, never
 * a bare literal — see `__tests__/terminal-states-consistency.ts`'s
 * `driverOnlyExitBindings`/`findExitConstantMismatches`/
 * `findConstantProvenanceMismatches`/`findBareLiteralExits` for the checks
 * this makes possible: the constants cannot diverge from this table (they
 * ARE this table's own values), and an AST scan catches a future edit that
 * reintroduces a bare literal, or reverts a declaration back to an
 * independent literal. The 'helper' entry is bound the same way:
 * `lib/state/mailbox.ts` exports `PUSH_HELD_EXIT = helperExitCode('PUSH_HELD')`.
 *
 * The 'class-label'/'tombstone' entries remain un-bound — neither is ever
 * itself emitted, so there is no call site to thread through a lookup
 * function the way `terminal`/`driverOnlyExitCode` are.
 *
 * The two `state`-category entries `drive-status.ts` sets OUTSIDE
 * `evaluate` — `SESSION_LEASE_HELD` and `DRIVE_HELD_BY_OTHER_WORKTREE` —
 * are bound too, the same way. Neither is a member of `EvaluateStateName`,
 * whose whole point is "what `evaluate.ts` itself may emit".
 * `outOfBandExitCode` below is their accessor: `lib/state/lease.ts` exports
 * `DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode('DRIVE_HELD_BY_OTHER_WORKTREE')`
 * and `SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD')`,
 * and `drive-status.ts` imports both rather than hand-writing `11`/`13` at
 * its own `case 0` sites; the consistency check's driver-only checks verify
 * this binding against the real files as well.
 */

import { Defect } from "../../../../../shared/errors.ts";

export type TerminalStateCategory =
  | "state"
  | "class-label"
  | "tombstone"
  | "driver-only"
  | "helper";

export interface TerminalStateEntry {
  /** The exit code `drive-status.ts` itself returns for this state. */
  readonly exitCode: number;
  /**
   * Additional exit codes a DIFFERENT script legitimately remaps this same
   * state to — today only `CONVERGED`, which `drive.ts` deliberately maps to
   * `0` so it composes with any harness reading a zero exit as success
   * (`SKILL.md` § Terminal states: "a `0` from `drive-status.ts` … and a `0`
   * from `drive.ts` … mean opposite things"). Not a second, independent
   * pairing to keep in step by hand — `drive.ts`'s own remap is its round
   * step's `case 3:` branch (`lib/driver/round-step.ts`), which exits `0`
   * after certifying the converged worktree, so this field exists so the drift checker does
   * not read `using-drive-pr.md`'s and `pr-lifecycle.md`'s documentation of
   * THAT remap as a wrong pairing, and so `DRIVE_EXIT` below gives the
   * dispatcher the code `drive.ts` itself exits. Those two files are the ONLY
   * ones the checker treats this way (`CorpusFile.documentsDriveTsRemap` in
   * `__tests__/terminal-states-consistency.ts`) — everywhere else
   * (`drive-status.ts`'s own header, `SKILL.md`, `references/
   * terminal-states.md`) documents `drive-status.ts`'s own contract and is
   * checked STRICTLY against `exitCode` alone, where `0` is genuinely
   * `ROUND_READY`, not `CONVERGED`.
   */
  readonly additionalExitCodes?: readonly number[];
  readonly category: TerminalStateCategory;
  /**
   * Ends the drive/round without the caller re-arming automatically.
   * `null` for the retired tombstone, which asserts nothing about a code
   * that is never emitted at all.
   */
  readonly terminal: boolean | null;
  /** Which script actually produces this exit — free text for the reader,
   * not itself checked against anything. */
  readonly emittedBy: string;
  /**
   * What the state or exit means to a reader that branches on it, in plain
   * language: what happened, and what the reader does next. The Protocol's
   * chapter prints it beside the value, and its gate fails an empty one.
   */
  readonly meaning: string;
}

/**
 * The states `lib/status/evaluate.ts` itself sets `report.state` to and
 * returns the matching exit code for — the ONLY subset actually bound in
 * code via `terminal()` below. Adding a state to `evaluate.ts` that is not a
 * member of this union is a compile error, not a runtime surprise.
 */
export type EvaluateStateName =
  | "ROUND_READY"
  | "CONVERGED"
  | "INDETERMINATE"
  | "UNSUPPORTED_CLI"
  | "HEAD_LAG"
  | "HEAD_MOVED"
  | "MERGEABILITY_UNKNOWN"
  | "AWAITING_REVIEWER"
  | "STALE_REVIEW"
  | "PR_NOT_OPEN"
  | "REVIEWER_FAILED"
  | "HITL_PARKED"
  | "PR_CONFLICTING"
  | "REVIEW_SKIPPED";

const EVALUATE_EMITTER = "drive-status.ts (lib/status/evaluate.ts)";

/**
 * The full terminal-state vocabulary — every entry the drift checker
 * validates the prose restatements against. Keyed by the exact `state`
 * name (or class/tombstone label) as it appears in the `--json` report or
 * in prose.
 *
 * Typed as a union of two Records rather than one wide `Record<string, …>`:
 * `EvaluateStateName` keys are guaranteed present (indexing one always
 * yields a real `TerminalStateEntry`, which is what `terminal()`'s callers
 * below rely on), while any OTHER string key — a name looked up from prose,
 * as the drift checker does — is `| undefined`, so a lookup that misses
 * still type-checks as possibly-missing instead of lying that every string
 * indexes to a real entry.
 */
export const TERMINAL_STATES: Readonly<
  Record<EvaluateStateName, TerminalStateEntry>
> &
  Readonly<Record<string, TerminalStateEntry | undefined>> = {
  // ── evaluate.ts's own states — code-bound via terminal() ─────────────────
  ROUND_READY: {
    exitCode: 0,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "Work is left for this round: open review threads or unanswered summary findings. The caller runs a pass; `drive.ts` runs it itself and never ends with this state.",
  },
  CONVERGED: {
    exitCode: 3,
    // drive.ts's own remap — see the field's own doc comment.
    additionalExitCodes: [0],
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The pull request is ready to merge: the reviewer reviewed this exact head and nothing is left open. `drive.ts` exits `0` for it, once its own working tree is clean.",
  },
  // Exit 4's family: the NOT_SETTLED class label below groups these five.
  HEAD_LAG: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The pull request's head on the forge and the local head disagree: a push has not shown up yet, or the working tree is behind. Wait, or bring the tree up to date, then read again.",
  },
  AWAITING_REVIEWER: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The reviewer has not reviewed this head yet. Wait, then read again.",
  },
  STALE_REVIEW: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The reviewer's latest review describes an earlier head. Wait for its review of this one, then read again.",
  },
  HEAD_MOVED: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The head or the base moved while the round was being judged, so nothing read about it holds. Read again.",
  },
  MERGEABILITY_UNKNOWN: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The forge has not yet worked out whether the pull request merges cleanly. Read again.",
  },
  PR_NOT_OPEN: {
    exitCode: 5,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The pull request was merged or closed. Stop, and push nothing to it.",
  },
  REVIEWER_FAILED: {
    exitCode: 7,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The reviewer's own check did not pass, so the absence of findings proves nothing. A person looks at the reviewer before re-arming.",
  },
  HITL_PARKED: {
    exitCode: 8,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "Everything left waits on a person's decision, each framed on its thread. The drive does not wake itself: once every one is answered, re-arm it.",
  },
  PR_CONFLICTING: {
    exitCode: 9,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The pull request conflicts with its base and has nothing else to work on; `drive.ts` ends with it once its conflict-repair passes are spent. Merge the base in, then re-arm.",
  },
  // The reviewer skipped the PR head, and its review of an earlier head does
  // not cover it (`reviewed-sha.ts`): no review of this head will come.
  REVIEW_SKIPPED: {
    exitCode: 22,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The reviewer skipped this head and its review of an earlier head does not cover it, so no review will come. A person has this head reviewed, then re-arms.",
  },
  INDETERMINATE: {
    exitCode: 1,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "The state could not be read, or a step failed: `drive.ts` also ends with it when a pass fails. Never a settled state; read what the drive printed before re-arming.",
  },
  UNSUPPORTED_CLI: {
    exitCode: 2,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
    meaning:
      "A prerequisite is missing: the installed `gh` cannot report a field the round needs. A refused command line exits `2` as well, with no report.",
  },

  // ── real states, set OUTSIDE evaluate() — code-bound via outOfBandExitCode()
  // below, not terminal ────────────────────────────────────────
  // `drive-status.ts`'s round-gate lease bumps (`bump-round`, `bump-attempt`)
  // each call `outOfBand(report, 'SESSION_LEASE_HELD', ...)`, which sets
  // `report.state` and returns `lib/state/lease.ts`'s
  // `SESSION_LEASE_HELD_EXIT` from ONE lookup.
  SESSION_LEASE_HELD: {
    exitCode: 11,
    category: "state",
    terminal: true,
    emittedBy: "drive-status.ts (round-gate lease bump, outside evaluate())",
    meaning:
      "Another live session in this working tree holds the drive's lease for this pull request. Nothing was changed: wait for it, or clear its lease once its process is gone.",
  },
  // Raised by `drive-state.ts` for the tree lease, propagated by
  // `drive-status.ts` through the same `outOfBand` call, plus its PR-wide
  // admission preflight, and raised by `drive.ts` at its own round-opening
  // `bump-attempt` and at arm for a driver in another clone.
  DRIVE_HELD_BY_OTHER_WORKTREE: {
    exitCode: 13,
    category: "state",
    terminal: true,
    emittedBy: "drive-state.ts, propagated by drive-status.ts and drive.ts",
    meaning:
      "Another live working tree, or a driver in another clone, is driving this pull request. Nothing was changed; that driver is the one to finish.",
  },

  // ── class label: never itself emitted, groups exit 4's five states ───────
  NOT_SETTLED: {
    exitCode: 4,
    category: "class-label",
    terminal: false,
    emittedBy:
      "never emitted — a class label for HEAD_LAG / AWAITING_REVIEWER / STALE_REVIEW / HEAD_MOVED / MERGEABILITY_UNKNOWN",
    meaning:
      "The name of every state that shares exit `4`: the pull request is not ready to judge yet. Never itself a `state`; the caller waits and runs the drive again.",
  },

  // ── tombstone: withdrawn, must never be re-emitted ────────────────────────
  RETIRED: {
    exitCode: 10,
    category: "tombstone",
    terminal: null,
    emittedBy: "never emitted — was PR_IS_DRAFT; the code is not recycled",
    meaning:
      "Withdrawn: it once stopped a drive on a draft pull request, which is now driven like any other. Never exited, and never given another meaning.",
  },

  // ── drive.ts-only exits: no --json report, code-bound via the constants
  // `lib/driver/settings.ts` exports (see the header) ──────────────────────
  MAX_ROUNDS: {
    exitCode: 6,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAX_ROUNDS_EXIT)",
    meaning:
      "The drive spent its round budget (`--max-rounds`) without converging. Read the handoff file before re-arming.",
  },
  // A successful pass left uncommitted fixes and current-round holds, or the
  // review converged over an unclean worktree.
  WORKTREE_UNCLEAN: {
    exitCode: 12,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (WORKTREE_UNCLEAN_EXIT)",
    meaning:
      "The working tree holds work no round shipped: uncommitted edits, an unfinished git operation or a commit nobody reviewed. Settle it, then re-arm in this tree.",
  },
  STALLED: {
    exitCode: 14,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (STALLED_EXIT)",
    meaning:
      "Rounds stopped changing anything the drive can see. Read what the passes decided, and what the tree still holds, before re-arming.",
  },
  PASS_DEADLINE: {
    exitCode: 15,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (PASS_DEADLINE_EXIT)",
    meaning:
      "A pass ran past its deadline and was stopped more often than the drive restarts one. Check the tree for the stopped pass's leftovers before re-arming.",
  },
  QUOTA_PARKED: {
    exitCode: 16,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (QUOTA_PARKED_EXIT)",
    meaning:
      "A pass hit an agent subscription's usage limit that does not reset soon. Re-arm after the reset, or from a session that bills another account.",
  },
  MAILBOX_STOPPED: {
    exitCode: 18,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAILBOX_STOPPED_EXIT)",
    meaning:
      "A person or a tool told the drive to stop through its mailbox, and it stopped at a round boundary.",
  },
  MAILBOX_PAUSE_TIMEOUT: {
    exitCode: 19,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAILBOX_PAUSE_TIMEOUT_EXIT)",
    meaning:
      "A pause sent through the drive's mailbox lasted longer than the drive waits. Resume it, then re-arm.",
  },
  // Its CI-repair passes spent on a fresh verdict that still names failing
  // checks.
  CI_REPAIR_SPENT: {
    exitCode: 21,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (CI_REPAIR_SPENT_EXIT)",
    meaning:
      "The review converged, but required checks still fail after the drive's CI-repair passes were spent. A re-armed drive repairs again.",
  },
  // Every failing check failed on the infrastructure (`shared/ci-infra.ts`)
  // and its re-runs and head moves are spent.
  CI_INFRA_PERSISTED: {
    exitCode: 23,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (CI_INFRA_PERSISTED_EXIT)",
    meaning:
      "The review converged, but checks kept failing on the CI service's own infrastructure after the drive re-ran them. Nothing in the code needs repair; re-arm once the service recovers.",
  },
  // A newer takeover claim from another clone, found at a round boundary, or
  // a rival's earlier claim that beat this driver's (`lib/driver/ledger.ts`).
  TAKEN_OVER: {
    exitCode: 20,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (TAKEN_OVER_EXIT)",
    meaning:
      "Another clone took the drive over and drives it now. Nothing to recover here.",
  },
  // drive.ts's own single-instance lock refusal, BEFORE drive-status.ts ever
  // runs — a distinct cause from SESSION_LEASE_HELD above, sharing the same
  // exit code by design (see references/terminal-states.md row 11).
  SINGLE_INSTANCE_LOCK: {
    exitCode: 11,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (SINGLE_INSTANCE_LOCK_EXIT)",
    meaning:
      "Another driver already holds this pull request's or this working tree's lock, so the drive is already armed. Nothing was changed.",
  },

  // ── helper exits: neither drive-status.ts nor drive.ts ends with these ────
  PUSH_HELD: {
    exitCode: 17,
    category: "helper",
    terminal: false,
    emittedBy: "guarded-push.ts and push-hold-recheck.ts (PUSH_HELD_EXIT)",
    meaning:
      "A `hold-push` directive in the drive's mailbox is in force, so nothing was pushed; the pre-push hook's recheck exits with it to stop a push already under way. Not an end state: clear the hold, then push again.",
  },
};

/**
 * Set `report.state` and return the matching exit code from ONE lookup, so
 * the two cannot be written to disagree at a call site. Throws on a name
 * outside `EvaluateStateName` at the type level (a typo or a state
 * `evaluate.ts` has no business emitting is a compile error) and, as a
 * belt-and-braces runtime check against a `TERMINAL_STATES` edit that drops
 * an entry the union still names, throws rather than silently returning
 * `undefined` as an exit code.
 */
export function terminal(
  report: { state: string; reason: string },
  name: EvaluateStateName,
  reason: string,
): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    // Unreachable while EvaluateStateName and TERMINAL_STATES agree — kept
    // as a fail-closed runtime guard rather than a silent `NaN` exit code
    // if the two are ever edited out of step.
    throw new Error(
      `terminal(): '${name}' has no TERMINAL_STATES entry — evaluate.ts and terminal-states.ts have drifted`,
    );
  }
  report.state = name;
  report.reason = reason;
  return entry.exitCode;
}

/**
 * The `category: 'driver-only'` entries `drive.ts` derives its own exported
 * exit constants from — real, known `TERMINAL_STATES` keys, but
 * outside `EvaluateStateName`, so `TERMINAL_STATES`'s own type (see its doc
 * comment above `TERMINAL_STATES` itself) resolves a bare
 * `TERMINAL_STATES.MAX_ROUNDS` access through the `| undefined` arm of the
 * intersection rather than the guaranteed one — `driverOnlyExitCode` below
 * exists so `drive.ts` does not need a `!`/non-null assertion at each of its
 * driver-only declarations to work around that.
 */
export type DriverOnlyStateName =
  | "MAX_ROUNDS"
  | "SINGLE_INSTANCE_LOCK"
  | "WORKTREE_UNCLEAN"
  | "STALLED"
  | "PASS_DEADLINE"
  | "QUOTA_PARKED"
  | "MAILBOX_STOPPED"
  | "MAILBOX_PAUSE_TIMEOUT"
  | "TAKEN_OVER"
  | "CI_REPAIR_SPENT"
  | "CI_INFRA_PERSISTED";

/**
 * `TERMINAL_STATES[name].exitCode` for a `DriverOnlyStateName`, throwing —
 * not returning `undefined` — if the entry is ever removed from the table,
 * the same fail-closed posture `terminal()` above takes for
 * `EvaluateStateName`. Unreachable while `DriverOnlyStateName` and
 * `TERMINAL_STATES` agree; kept as a runtime guard against the two being
 * edited out of step, exactly like `terminal()`'s own belt-and-braces check.
 */
export function driverOnlyExitCode(name: DriverOnlyStateName): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    throw new Error(
      `driverOnlyExitCode(): '${name}' has no TERMINAL_STATES entry — drive.ts and terminal-states.ts have drifted`,
    );
  }
  return entry.exitCode;
}

/**
 * The `category: 'state'` entries `drive-status.ts` sets OUTSIDE `evaluate`
 * — real, known `TERMINAL_STATES` keys, but outside
 * `EvaluateStateName` for the same reason the driver-only entries are:
 * `evaluate` itself never sets either of these, so folding them into that
 * union would misstate what it actually emits. `outOfBandExitCode` below is
 * `driverOnlyExitCode`'s sibling for this pair, used by `lib/state/lease.ts`
 * to derive `SESSION_LEASE_HELD_EXIT` and `DRIVE_HELD_ELSEWHERE_EXIT` rather
 * than hand-writing `11`/`13` as independent literals.
 */
export type OutOfBandStateName =
  | "SESSION_LEASE_HELD"
  | "DRIVE_HELD_BY_OTHER_WORKTREE";

/**
 * `TERMINAL_STATES[name].exitCode` for an `OutOfBandStateName`, throwing —
 * not returning `undefined` — if the entry is ever removed from the table,
 * the same fail-closed posture `terminal()`/`driverOnlyExitCode()` above take
 * for their own name unions. Unreachable while `OutOfBandStateName` and
 * `TERMINAL_STATES` agree; kept as a runtime guard against the two being
 * edited out of step.
 */
export function outOfBandExitCode(name: OutOfBandStateName): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    throw new Error(
      `outOfBandExitCode(): '${name}' has no TERMINAL_STATES entry — lease.ts and terminal-states.ts have drifted`,
    );
  }
  return entry.exitCode;
}

/**
 * Set `report.state` and return the matching exit code from ONE lookup, so
 * the two cannot be written to disagree at a call site — `terminal`'s own
 * sibling for `OutOfBandStateName`. Before this, a `drive-status.ts` branch
 * set `report.state` by hand and separately `emit`ted/`return`ed its own
 * imported `*_EXIT` constant; nothing tied the two together, so a branch that
 * set `report.state = 'SESSION_LEASE_HELD'` but emitted/returned
 * `DRIVE_HELD_ELSEWHERE_EXIT` (or vice versa) would recreate the exact
 * pairing drift `terminal-states.ts` exists to prevent, and
 * `findBareLiteralExits` in `__tests__/terminal-states-consistency.ts`
 * cannot catch it: that check only rejects a bare numeric literal, and
 * either sibling constant is an equally well-formed named identifier
 *. Deriving both values from
 * one `name` argument closes the gap at the source instead of adding a
 * second AST scan to detect it after the fact.
 */
export function outOfBand(
  report: { state: string; reason: string },
  name: OutOfBandStateName,
  reason: string,
): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    throw new Error(
      `outOfBand(): '${name}' has no TERMINAL_STATES entry — drive-status.ts and terminal-states.ts have drifted`,
    );
  }
  report.state = name;
  report.reason = reason;
  return entry.exitCode;
}

/**
 * The `category: 'helper'` entries a drive helper script derives its exit
 * constant from: `lib/state/mailbox.ts`'s `PUSH_HELD_EXIT`, which
 * `guarded-push.ts` and `push-hold-recheck.ts` return.
 */
export type HelperStateName = "PUSH_HELD";

/**
 * `TERMINAL_STATES[name].exitCode` for a `HelperStateName`, throwing — not
 * returning `undefined` — if the entry is ever removed from the table, the
 * same fail-closed posture as `driverOnlyExitCode()`.
 */
export function helperExitCode(name: HelperStateName): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    throw new Defect(
      `helperExitCode(): '${name}' has no TERMINAL_STATES entry — mailbox.ts and terminal-states.ts have drifted`,
    );
  }
  return entry.exitCode;
}

// ── What the dispatcher reads: `drive.ts`'s own exits ─────────────────────

/**
 * The states whose exit the dispatcher reads from `drive.ts`
 * (`dispatch/run.ts`, `dispatch/lib/launches.ts`, `dispatch/lib/log.ts`,
 * `dispatch/lib/sources/ledgers.ts`): every exit `drive.ts` can end with, by
 * the name this table gives it. `SESSION_LEASE_HELD` shares
 * `SINGLE_INSTANCE_LOCK`'s code and `drive.ts` reports neither apart, so the
 * dispatcher names that code by the driver's own refusal.
 */
export type DriveExitName =
  | "CONVERGED"
  | "INDETERMINATE"
  | "UNSUPPORTED_CLI"
  | "NOT_SETTLED"
  | "PR_NOT_OPEN"
  | "MAX_ROUNDS"
  | "REVIEWER_FAILED"
  | "HITL_PARKED"
  | "PR_CONFLICTING"
  | "REVIEW_SKIPPED"
  | "SINGLE_INSTANCE_LOCK"
  | "WORKTREE_UNCLEAN"
  | "DRIVE_HELD_BY_OTHER_WORKTREE"
  | "STALLED"
  | "PASS_DEADLINE"
  | "QUOTA_PARKED"
  | "MAILBOX_STOPPED"
  | "MAILBOX_PAUSE_TIMEOUT"
  | "TAKEN_OVER"
  | "CI_REPAIR_SPENT"
  | "CI_INFRA_PERSISTED";

const DRIVE_EXIT_NAMES: readonly DriveExitName[] = [
  "CONVERGED",
  "INDETERMINATE",
  "UNSUPPORTED_CLI",
  "NOT_SETTLED",
  "PR_NOT_OPEN",
  "MAX_ROUNDS",
  "REVIEWER_FAILED",
  "HITL_PARKED",
  "PR_CONFLICTING",
  "REVIEW_SKIPPED",
  "SINGLE_INSTANCE_LOCK",
  "WORKTREE_UNCLEAN",
  "DRIVE_HELD_BY_OTHER_WORKTREE",
  "STALLED",
  "PASS_DEADLINE",
  "QUOTA_PARKED",
  "MAILBOX_STOPPED",
  "MAILBOX_PAUSE_TIMEOUT",
  "TAKEN_OVER",
  "CI_REPAIR_SPENT",
  "CI_INFRA_PERSISTED",
];

/**
 * The exit `drive.ts` ends with for `name`: the code it remaps the state to
 * when the table records one (`CONVERGED`, which `drive.ts` exits `0`), else
 * the state's own code. Throws when the table has no such entry, as
 * `terminal()` does.
 */
function driveExitCode(name: DriveExitName): number {
  const entry = TERMINAL_STATES[name];
  if (entry === undefined) {
    throw new Defect(
      `driveExitCode(): '${name}' has no TERMINAL_STATES entry — the dispatcher and terminal-states.ts have drifted`,
    );
  }
  return entry.additionalExitCodes?.[0] ?? entry.exitCode;
}

/** `drive.ts`'s exit for each state the dispatcher reads, by the state's name. */
export const DRIVE_EXIT: Readonly<Record<DriveExitName, number>> =
  Object.freeze(
    Object.fromEntries(
      DRIVE_EXIT_NAMES.map((name) => [name, driveExitCode(name)]),
    ) as Record<DriveExitName, number>,
  );

/**
 * The state a `drive.ts` exit names, as this table gives it: the first state
 * in `DRIVE_EXIT_NAMES` order with that code, so `0` is `CONVERGED`, `4` the
 * `NOT_SETTLED` class and `11` the driver's own `SINGLE_INSTANCE_LOCK`;
 * `null` for a code `drive.ts` never exits with.
 */
export function driveExitName(code: number): DriveExitName | null {
  return DRIVE_EXIT_NAMES.find((name) => DRIVE_EXIT[name] === code) ?? null;
}

/**
 * `drive.ts`'s refusals of a second driver: this clone's lock is held,
 * another working tree drives the pull request, or another clone took the
 * drive over. Each is the stage's answer while the ledger's facts hold.
 */
export const DRIVER_REFUSAL_EXITS: ReadonlySet<number> = new Set([
  DRIVE_EXIT.SINGLE_INSTANCE_LOCK,
  DRIVE_EXIT.DRIVE_HELD_BY_OTHER_WORKTREE,
  DRIVE_EXIT.TAKEN_OVER,
]);

/** A person's stop through the drive's mailbox: a `stop`, or a `pause` that outlasted its wait. */
export const PERSON_STOP_EXITS: ReadonlySet<number> = new Set([
  DRIVE_EXIT.MAILBOX_STOPPED,
  DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT,
]);

/**
 * The exits that leave nothing for a person in the drive's terminal tab:
 * converged, merged or closed, re-armable (a usage-limit wall, a pull request
 * not judgeable yet, an infrastructure failure the dispatcher re-drives), a
 * person's stop, or a refusal of a second driver.
 */
const TAB_CLOSING_EXITS: ReadonlySet<number> = new Set([
  DRIVE_EXIT.CONVERGED,
  DRIVE_EXIT.PR_NOT_OPEN,
  DRIVE_EXIT.QUOTA_PARKED,
  DRIVE_EXIT.NOT_SETTLED,
  DRIVE_EXIT.CI_INFRA_PERSISTED,
  ...PERSON_STOP_EXITS,
  ...DRIVER_REFUSAL_EXITS,
]);

/**
 * Whether a drive that exited `code` closes its run tab, which
 * `shared/orca-tabs.ts` then does: only an exit in `TAB_CLOSING_EXITS`. A
 * park, any other exit and a signal (`null`) keep the tab for a person.
 */
export function driveExitClosesTab(code: number | null): boolean {
  return code !== null && TAB_CLOSING_EXITS.has(code);
}

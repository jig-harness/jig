/**
 * The single, code-bound source of truth for the drive's terminal-state
 * vocabulary — which `state` name pairs with which exit code, and what kind
 * of pairing it is.
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
 * Categories of entry (`drive-status.ts`'s "Exit codes — the driver contract"
 * doc comment mixes all four in one column, unmarked):
 *
 *   'state'        a real `state` value the `--json` report can carry.
 *   'class-label'  a name for a FAMILY of states sharing one exit code,
 *                  never itself emitted (`NOT_SETTLED` for exit `4`).
 *   'tombstone'    a withdrawn code, deliberately never re-emitted
 *                  (`RETIRED`, exit `10`, was `PR_IS_DRAFT`).
 *   'driver-only'  a `drive.ts`-only exit that produces no `--json` report
 *                  at all (`PASS_DEADLINE`, `QUOTA_PARKED`, and the unnamed
 *                  codes `drive.ts` returns directly).
 *
 * `evaluate.ts`'s own 'state' entries are bound in code (the
 * `EvaluateStateName` union below, consumed by `terminal`): every site in
 * `evaluate.ts` sets both through it. Every
 * 'driver-only' entry (`MAX_ROUNDS`, `SINGLE_INSTANCE_LOCK`,
 * `WORKTREE_UNCLEAN`, `STALLED`, `PASS_DEADLINE`, `QUOTA_PARKED`,
 * `MAILBOX_STOPPED`, `MAILBOX_PAUSE_TIMEOUT`) is bound
 * the OTHER direction: `drive.ts` exports a named constant for
 * each — `MAX_ROUNDS_EXIT`, `SINGLE_INSTANCE_LOCK_EXIT`,
 * `WORKTREE_UNCLEAN_EXIT`, `STALLED_EXIT`, `PASS_DEADLINE_EXIT`,
 * `QUOTA_PARKED_EXIT`, `MAILBOX_STOPPED_EXIT`, `MAILBOX_PAUSE_TIMEOUT_EXIT`
 * — each read via `driverOnlyExitCode` below (e.g.
 * `export const MAX_ROUNDS_EXIT = driverOnlyExitCode('MAX_ROUNDS')`), the
 * `DriverOnlyStateName`-typed sibling of `terminal`'s own
 * `EvaluateStateName` lookup, and every one of `drive.ts`'s own `return`
 * sites for these driver-only codes uses the constant, never a bare literal
 * — see `__tests__/terminal-states-consistency.ts`'s own
 * `driverOnlyExitBindings`/`findExitConstantMismatches`/
 * `findConstantProvenanceMismatches`/`findBareLiteralExits` for the checks
 * this makes possible: the constants cannot diverge from this table (they
 * ARE this table's own values), and a real AST scan catches a future edit
 * that reintroduces a bare literal, or reverts a declaration back to an
 * independent literal, at any of these driver-only exits instead of using
 * its constant.
 *
 * The 'class-label'/'tombstone' entries remain un-bound — neither is ever
 * itself emitted, so there is no call site to thread through a lookup
 * function the way `terminal`/`driverOnlyExitCode` are.
 *
 * The two `state`-category entries `drive-status.ts` sets OUTSIDE
 * `evaluate` — `SESSION_LEASE_HELD` and `DRIVE_HELD_BY_OTHER_WORKTREE` —
 * are bound too, closing the gap an earlier change explicitly carved out
 * ("A future issue can extend the code-binding to `drive-status.ts`'s
 * non-`evaluate` sites and to `DRIVE_HELD_ELSEWHERE_EXIT`'s own
 * declaration the same way an earlier change does for `drive.ts`'s driver-only
 * exits" — the second time this exact residual was carved out and pushed to
 * "a future issue" without one being filed; an earlier change is that issue). Neither
 * is a member of `EvaluateStateName` — that union's whole point is "what
 * `evaluate.ts` itself may emit", and `evaluate`
 * never sets either of these. `outOfBandExitCode` below is their own
 * `driverOnlyExitCode`-shaped accessor: `lib/state/lease.ts` exports
 * `DRIVE_HELD_ELSEWHERE_EXIT = outOfBandExitCode('DRIVE_HELD_BY_OTHER_WORKTREE')`
 * and `SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD')`,
 * and `drive-status.ts` imports both rather than hand-writing `11`/`13` at
 * its own `case 0` sites. `__tests__/terminal-states-consistency.ts`
 * extends its driver-only checks
 * (`findExitConstantMismatches`/`findConstantProvenanceMismatches`/
 * `findBareLiteralExits`) to verify this binding against the real files, the
 * same way it already does for `drive.ts`'s driver-only exits.
 */

export type TerminalStateCategory =
  | "state"
  | "class-label"
  | "tombstone"
  | "driver-only";

export interface TerminalStateEntry {
  /** The exit code `drive-status.ts` itself returns for this state. */
  readonly exitCode: number;
  /**
   * Additional exit codes a DIFFERENT script legitimately remaps this same
   * state to — today only `CONVERGED`, which `drive.ts` deliberately maps to
   * `0` so it composes with any harness reading a zero exit as success
   * (`SKILL.md` § Terminal states: "a `0` from `drive-status.ts` … and a `0`
   * from `drive.ts` … mean opposite things"). Not a second, independent
   * pairing to keep in step by hand — `drive.ts`'s own remap is its `case 3:`
   * branch (`scripts/drive.ts`, ending `return 0` after certifying the
   * converged worktree), so this field exists only so the drift checker does
   * not read `using-drive-pr.md`'s and `pr-lifecycle.md`'s documentation of
   * THAT remap as a wrong pairing. Those two files are the ONLY ones the
   * checker treats this way (`CorpusFile.documentsDriveTsRemap` in
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
  | "PR_CONFLICTING";

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
  },
  CONVERGED: {
    exitCode: 3,
    // drive.ts's own remap — see the field's own doc comment.
    additionalExitCodes: [0],
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  // Exit 4's family: the NOT_SETTLED class label below groups these five.
  HEAD_LAG: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
  },
  AWAITING_REVIEWER: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
  },
  STALE_REVIEW: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
  },
  HEAD_MOVED: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
  },
  MERGEABILITY_UNKNOWN: {
    exitCode: 4,
    category: "state",
    terminal: false,
    emittedBy: EVALUATE_EMITTER,
  },
  PR_NOT_OPEN: {
    exitCode: 5,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  REVIEWER_FAILED: {
    exitCode: 7,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  HITL_PARKED: {
    exitCode: 8,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  PR_CONFLICTING: {
    exitCode: 9,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  INDETERMINATE: {
    exitCode: 1,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },
  UNSUPPORTED_CLI: {
    exitCode: 2,
    category: "state",
    terminal: true,
    emittedBy: EVALUATE_EMITTER,
  },

  // ── real states, set OUTSIDE evaluate() — code-bound via outOfBandExitCode()
  // below, not terminal ────────────────────────────────────────
  // `drive-status.ts`'s own round-gate lease bump (`bump-round`/`bump-attempt`
  // returning `SESSION_LEASE_HELD_EXIT`), verified: scripts/drive-status.ts's
  // `bump-round` and `bump-attempt` sites, both inside its single `case 0`
  // block, each call `outOfBand(report, 'SESSION_LEASE_HELD', ...)`
  // — which sets `report.state` and returns `lib/state/lease.ts`'s
  // exported `SESSION_LEASE_HELD_EXIT = outOfBandExitCode('SESSION_LEASE_HELD')`
  // from that ONE lookup, so the two cannot drift apart at either site
  // independently of `evaluate()` and of each other.
  SESSION_LEASE_HELD: {
    exitCode: 11,
    category: "state",
    terminal: true,
    emittedBy: "drive-status.ts (round-gate lease bump, outside evaluate())",
  },
  // Raised by `drive-state.ts` for the tree lease, propagated
  // verbatim by `drive-status.ts` via the same `outOfBand(report,
  // 'DRIVE_HELD_BY_OTHER_WORKTREE', ...)` call at both of
  // SESSION_LEASE_HELD's own sites above, plus `drive-status.ts`'s own
  // PR-wide admission preflight (which SESSION_LEASE_HELD has no sibling
  // site for), and raised independently by `drive.ts` at its own
  // round-opening `bump-attempt`.
  DRIVE_HELD_BY_OTHER_WORKTREE: {
    exitCode: 13,
    category: "state",
    terminal: true,
    emittedBy: "drive-state.ts, propagated by drive-status.ts and drive.ts",
  },

  // ── class label: never itself emitted, groups exit 4's five states ───────
  NOT_SETTLED: {
    exitCode: 4,
    category: "class-label",
    terminal: false,
    emittedBy:
      "never emitted — a class label for HEAD_LAG / AWAITING_REVIEWER / STALE_REVIEW / HEAD_MOVED / MERGEABILITY_UNKNOWN",
  },

  // ── tombstone: withdrawn, must never be re-emitted ────────────────────────
  RETIRED: {
    exitCode: 10,
    category: "tombstone",
    terminal: null,
    emittedBy: "never emitted — was PR_IS_DRAFT; the code is not recycled",
  },

  // ── drive.ts-only exits: no --json report, code-bound via drive.ts's own
  // exported constants ───────────────────────────────────────────
  // drive.ts's --max-rounds check. `drive.ts` exports `MAX_ROUNDS_EXIT =
  // driverOnlyExitCode('MAX_ROUNDS')`, and both its `return` sites use that
  // constant — no bare literal, no named `state` field (drive.ts proxies
  // drive-status.ts's own report but does not itself write one for this
  // exit). `check-drive-pr-terminal-states.ts`'s `findBareLiteralExits`
  // scans drive.ts for a bare-literal regression at this exit.
  MAX_ROUNDS: {
    exitCode: 6,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAX_ROUNDS_EXIT)",
  },
  // drive.ts's worktree-cleanliness checks (uncommitted state, an
  // unconcluded git operation, a local HEAD that does not match the reviewed
  // head). `drive.ts` exports `WORKTREE_UNCLEAN_EXIT =
  // driverOnlyExitCode('WORKTREE_UNCLEAN')`, and every one of its several
  // `return` sites for this check uses that constant.
  WORKTREE_UNCLEAN: {
    exitCode: 12,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (WORKTREE_UNCLEAN_EXIT)",
  },
  // drive.ts's stall-streak check. `drive.ts` exports `STALLED_EXIT =
  // driverOnlyExitCode('STALLED')`.
  STALLED: {
    exitCode: 14,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (STALLED_EXIT)",
  },
  // `drive.ts` exports `PASS_DEADLINE_EXIT =
  // driverOnlyExitCode('PASS_DEADLINE')` — previously an independent literal
  // (`= 15`) that merely happened to match this entry; now derived from it
  // directly.
  PASS_DEADLINE: {
    exitCode: 15,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (PASS_DEADLINE_EXIT)",
  },
  // `drive.ts` exports `QUOTA_PARKED_EXIT =
  // driverOnlyExitCode('QUOTA_PARKED')` — same previously-independent-literal
  // history as PASS_DEADLINE above.
  QUOTA_PARKED: {
    exitCode: 16,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (QUOTA_PARKED_EXIT)",
  },
  MAILBOX_STOPPED: {
    exitCode: 18,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAILBOX_STOPPED_EXIT)",
  },
  MAILBOX_PAUSE_TIMEOUT: {
    exitCode: 19,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (MAILBOX_PAUSE_TIMEOUT_EXIT)",
  },
  // drive.ts's own single-instance lock refusal, BEFORE drive-status.ts ever
  // runs — a distinct cause from SESSION_LEASE_HELD above, sharing the same
  // exit code by design (see references/terminal-states.md row 11).
  // `drive.ts` exports `SINGLE_INSTANCE_LOCK_EXIT =
  // driverOnlyExitCode('SINGLE_INSTANCE_LOCK')`, and every one of its
  // several `return` sites at the worktree/PR lock acquisitions (none
  // carrying a `report.state` write of their own) uses that constant.
  SINGLE_INSTANCE_LOCK: {
    exitCode: 11,
    category: "driver-only",
    terminal: true,
    emittedBy: "drive.ts only (SINGLE_INSTANCE_LOCK_EXIT)",
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
  | "MAILBOX_PAUSE_TIMEOUT";

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

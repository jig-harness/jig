/**
 * The structural-churn brake's resumable subset on the drive ledger: how a
 * state's bounded `roundPaths` window and `churnAckRound` travel in the
 * ledger, how the parser validates them, how the size cut trims `roundPaths`
 * oldest-first without dropping `churnAckRound`, and how a takeover restores
 * both onto a clone's state.
 */
import {
  isUsableRoundPaths,
  ROUND_PATHS_WINDOW,
  type RoundPaths,
} from "./round-paths.ts";

/** What `cut` names when the size cut drops round-path history. */
export const ROUND_PATHS_CUT = "the round paths";
export const OLDER_ROUND_PATHS_CUT = "the older round paths";

/** Whether `cut` records that round-path history was dropped. */
export function hasRoundPathsCut(cut: readonly string[]): boolean {
  return cut.some((c) => c === ROUND_PATHS_CUT || c === OLDER_ROUND_PATHS_CUT);
}

/** The brake's bounded evidence and acknowledgment as the ledger carries them. */
export function ledgerChurnFields(s: {
  roundPaths: readonly RoundPaths[];
  churnAckRound?: number;
}): { roundPaths?: RoundPaths[]; churnAckRound?: number } {
  const roundPaths = s.roundPaths.slice(-ROUND_PATHS_WINDOW);
  return {
    ...(roundPaths.length === 0 ? {} : { roundPaths }),
    ...(s.churnAckRound === undefined
      ? {}
      : { churnAckRound: s.churnAckRound }),
  };
}

/** Whether a ledger's optional `roundPaths` fits the stored window for `round`. */
export function isOptionalLedgerRoundPaths(
  value: unknown,
  round: unknown,
): boolean {
  if (value === undefined) return true;
  return (
    typeof round === "number" &&
    Number.isInteger(round) &&
    round >= 0 &&
    Array.isArray(value) &&
    value.length <= ROUND_PATHS_WINDOW &&
    isUsableRoundPaths(value, round, 0)
  );
}

/** Whether a ledger's optional `churnAckRound` is a round no later than `round`. */
export function isOptionalChurnAckRound(
  value: unknown,
  round: unknown,
): boolean {
  if (value === undefined) return true;
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    typeof round === "number" &&
    Number.isInteger(round) &&
    value <= round
  );
}

/**
 * Trim `roundPaths` oldest-first until the rendered body fits `limit`, keeping
 * `churnAckRound` intact so an answered park is never forgotten under size pressure.
 */
export function cutRoundPathsToFit<
  L extends { roundPaths?: RoundPaths[]; cut: string[] },
>(
  ledger: L,
  limit: number,
  measure: (candidate: L) => { body: string; bytes: number },
): { ledger: L; body: string } | { ledger: L } {
  const paths = ledger.roundPaths ?? [];
  const cutBefore = ledger.cut.filter(
    (c) => c !== ROUND_PATHS_CUT && c !== OLDER_ROUND_PATHS_CUT,
  );
  let current = ledger;
  for (let keep = paths.length - 1; keep >= 0; keep--) {
    current = {
      ...ledger,
      roundPaths: paths.slice(paths.length - keep),
      cut: [...cutBefore, keep === 0 ? ROUND_PATHS_CUT : OLDER_ROUND_PATHS_CUT],
    };
    const measured = measure(current);
    if (measured.bytes <= limit)
      return { ledger: current, body: measured.body };
  }
  return { ledger: current };
}

/**
 * Whether a seeded state's structural-churn evidence is incomplete because the
 * ledger cut unacknowledged `roundPaths` entries. Entries at or before
 * `churnAckRound` are already consumed, so dropping only them loses nothing the
 * brake reads.
 */
function seededEvidenceLost(opts: {
  pathsCut: boolean;
  hasLedgerPaths: boolean;
  rewound: boolean;
  round: number;
  roundPaths: readonly RoundPaths[];
  ack: number;
  localLost: boolean;
}): boolean {
  if (opts.ack >= opts.round) return false;
  if (opts.pathsCut) {
    const oldest = opts.roundPaths[0]?.round;
    return oldest === undefined || oldest > opts.ack + 1;
  }
  return !opts.hasLedgerPaths && !opts.rewound && opts.localLost;
}

/**
 * Restore the brake's evidence, acknowledgment, and incomplete-evidence flag
 * from a ledger onto `local`. A ledger carrying `roundPaths` (or a round-paths
 * size cut) replaces `local.roundPaths`; one without (written before the field
 * existed) keeps `local.roundPaths` unless the ledger rewound behind
 * `local.rounds`. `churnAckRound` restores from the ledger whenever present,
 * and clears when the ledger rewound or carried round-path state without an
 * acknowledgment.
 */
export function seedChurnFields(
  local: {
    rounds: number;
    roundPaths: RoundPaths[];
    churnAckRound?: number;
    churnEvidenceLost?: boolean;
  },
  ledger: {
    round: number;
    roundPaths?: RoundPaths[];
    churnAckRound?: number;
    cut: readonly string[];
  },
): {
  roundPaths: RoundPaths[];
  churnAckRound?: number;
  churnEvidenceLost?: boolean;
} {
  const rewound = ledger.round < local.rounds;
  const pathsCut = hasRoundPathsCut(ledger.cut);
  const hasLedgerPaths = ledger.roundPaths !== undefined || pathsCut;
  const roundPaths = hasLedgerPaths
    ? (ledger.roundPaths ?? [])
    : rewound
      ? []
      : local.roundPaths;
  const churnAckRound =
    ledger.churnAckRound !== undefined
      ? ledger.churnAckRound
      : rewound || hasLedgerPaths
        ? undefined
        : local.churnAckRound;
  const lost = seededEvidenceLost({
    pathsCut,
    hasLedgerPaths,
    rewound,
    round: ledger.round,
    roundPaths,
    ack: churnAckRound ?? 0,
    localLost: local.churnEvidenceLost === true,
  });
  return {
    roundPaths,
    ...(churnAckRound === undefined ? {} : { churnAckRound }),
    ...(lost ? { churnEvidenceLost: true } : {}),
  };
}

/**
 * The structural-churn brake's predicate: does the recorded round evidence
 * show a drive spending rounds without converging, in one of two shapes?
 *
 *   - same-file: one file drew findings in each of the last N recorded
 *     rounds, consecutive, none of them carrying a `high` or `blocker`
 *     finding, and the file was positively rewritten between each pair of them. Fixing
 *     low-value findings on one file round after round is how a drive spends
 *     its budget without converging; a round with a severe finding is real
 *     work, so it breaks the streak.
 *   - oscillation: a file's content at one round's head came back at a later
 *     round's head after a different content in between (A, B, A): the
 *     rounds are undoing each other. Severity does not suppress it. Contents
 *     are recorded only for the files that drew findings in a round, so the
 *     return is judged among the rounds in which the file drew a finding; a
 *     file that returns while only other files draw findings is not seen.
 *
 * Both shapes need positive evidence: a blob that could not be read never
 * counts as a rewrite or a return.
 *
 * Pure: it reads only the state it is given. `churnAckRound` consumes the
 * evidence at or before it, so a person's answer to the park the brake
 * raised restarts the count. Only the rounds the stored window keeps
 * (`ROUND_PATHS_WINDOW`) are read, which is why `drive.churn_rounds` is
 * capped at the window.
 */
import { ROUND_PATHS_WINDOW, type RoundPaths } from "./round-paths.ts";

/** The decision class the brake parks under (`shared/acts.ts`). */
export const CHURN_CLASS = "structural-churn";

/** `drive.churn_rounds` when nothing sets it. */
export const DEFAULT_CHURN_ROUNDS = 4;

/** The fewest rounds a same-file streak may be set to; `0` turns the brake off. */
export const MIN_CHURN_ROUNDS = 2;

/** The most: the brake reads only the rounds the stored window keeps. */
export const MAX_CHURN_ROUNDS = ROUND_PATHS_WINDOW;

/** What tripped the brake: its kind, the files and the rounds. */
export interface ChurnTrip {
  kind: "same-file" | "oscillation";
  paths: string[];
  rounds: number[];
}

/** The part of a drive state the predicate reads. */
export interface ChurnEvidence {
  roundPaths?: readonly RoundPaths[];
  churnAckRound?: number;
}

/** The parked key of the brake's decision at `round`. */
export function churnKey(round: number): string {
  return `${CHURN_CLASS}-r${round}`;
}

/** The blob a round recorded for `path`, as an own entry only. */
function blobOf(e: RoundPaths, path: string): string | undefined {
  return e.blobs !== undefined && Object.hasOwn(e.blobs, path)
    ? e.blobs[path]
    : undefined;
}

/**
 * Whether `path` is positively known to have changed between two rounds: both
 * blobs were read and differ. A blob that could not be read is no evidence.
 */
function rewritten(a: RoundPaths, b: RoundPaths, path: string): boolean {
  const before = blobOf(a, path);
  const after = blobOf(b, path);
  return before !== undefined && after !== undefined && before !== after;
}

function sameFile(entries: readonly RoundPaths[], n: number): ChurnTrip | null {
  if (entries.length < n) return null;
  const streak = entries.slice(-n);
  for (let i = 1; i < streak.length; i++) {
    const prev = streak[i - 1];
    const cur = streak[i];
    if (prev === undefined || cur === undefined) return null;
    if (cur.round !== prev.round + 1) return null;
  }
  // A round recorded without the fact is evidence nobody gathered, so it
  // never counts toward a streak; a severe round is real work.
  if (streak.some((e) => e.severe !== false)) return null;
  const [first, ...rest] = streak;
  if (first === undefined) return null;
  const paths = first.paths.filter((path) =>
    rest.every((e, i) => {
      const prev = streak[i];
      return (
        prev !== undefined && e.paths.includes(path) && rewritten(prev, e, path)
      );
    }),
  );
  return paths.length === 0
    ? null
    : { kind: "same-file", paths, rounds: streak.map((e) => e.round) };
}

/** The rounds at which `path` returned to an earlier content, or `null`. */
function returnOf(
  entries: readonly RoundPaths[],
  path: string,
): number[] | null {
  const seen = new Map<string, number>();
  let prev: { blob: string; round: number } | null = null;
  for (const e of entries) {
    const blob = blobOf(e, path);
    if (blob === undefined) continue;
    const earlier = seen.get(blob);
    if (prev !== null && prev.blob !== blob && earlier !== undefined)
      return [earlier, prev.round, e.round];
    if (earlier === undefined) seen.set(blob, e.round);
    prev = { blob, round: e.round };
  }
  return null;
}

function oscillation(entries: readonly RoundPaths[]): ChurnTrip | null {
  const paths = [...new Set(entries.flatMap((e) => e.paths))].sort();
  const found = paths.flatMap((path) => {
    const rounds = returnOf(entries, path);
    return rounds === null ? [] : [{ path, rounds }];
  });
  if (found.length === 0) return null;
  return {
    kind: "oscillation",
    paths: found.map((f) => f.path),
    rounds: [...new Set(found.flatMap((f) => f.rounds))].sort((a, b) => a - b),
  };
}

/**
 * Whether the evidence after `churnAckRound` trips the brake with a same-file
 * streak of `rounds` rounds, or an oscillation; `null` when it does not, or
 * when `rounds` is `0` (the brake is off).
 */
export function structuralChurn(
  s: ChurnEvidence,
  opts: { rounds: number },
): ChurnTrip | null {
  if (opts.rounds < MIN_CHURN_ROUNDS) return null;
  const since = s.churnAckRound ?? 0;
  const entries = [...(s.roundPaths ?? [])]
    .filter((e) => e.round > since)
    .sort((a, b) => a.round - b.round)
    .slice(-ROUND_PATHS_WINDOW);
  return sameFile(entries, opts.rounds) ?? oscillation(entries);
}

/**
 * Whether the newest recorded round is unmeasured (no severity fact) and the
 * rounds before it would make a same-file streak with it were it measured
 * clean: consecutive, none severe, sharing a file. Such a round is no
 * measured non-trip: the gate must not let it run as though the brake had
 * judged it.
 */
export function churnUnmeasured(
  s: ChurnEvidence,
  opts: { rounds: number },
): boolean {
  if (opts.rounds < MIN_CHURN_ROUNDS) return false;
  const since = s.churnAckRound ?? 0;
  const entries = [...(s.roundPaths ?? [])]
    .filter((e) => e.round > since)
    .sort((a, b) => a.round - b.round)
    .slice(-ROUND_PATHS_WINDOW);
  if (entries.length < opts.rounds) return false;
  const streak = entries.slice(-opts.rounds);
  const last = streak.at(-1);
  if (last === undefined || last.severe !== undefined) return false;
  for (let i = 1; i < streak.length; i++)
    if (streak[i]?.round !== (streak[i - 1]?.round ?? -2) + 1) return false;
  if (streak.slice(0, -1).some((e) => e.severe !== false)) return false;
  return last.paths.some((path) => streak.every((e) => e.paths.includes(path)));
}

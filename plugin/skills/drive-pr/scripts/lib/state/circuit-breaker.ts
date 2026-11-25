/**
 * The drive's economic circuit breaker, as the drive state keeps it: the
 * round ceiling, the wall-clock cap and the divergence stop.
 *
 * The round ceiling caps the distinct reviewed heads (`rounds`) a pull
 * request spends across every launch, re-arm and takeover. The budget a
 * drive enforces is the smaller of its round budget (`--max-rounds` plus
 * `roundsGranted`) and the ceiling (`drive.max_total_rounds` plus
 * `ceilingRaised`). A re-arm's grant never reaches past the ceiling; only a
 * person's override (`--past-ceiling`, or the override option of the
 * `round-ceiling` park) raises it, by one `--max-rounds` block.
 *
 * The wall-clock cap (`drive.max_wall_clock_hours`) is measured from
 * `firstDrivenAt`, written by the first launch and never reset; an override
 * moves it on by one more cap.
 *
 * The divergence stop compares each round gate's open review findings (the
 * unresolved threads and unaddressed summary findings the gate reports)
 * with the previous gate's: `newFindings` were not open before, and
 * `fixedFindings` are no longer open. A round diverges when it raised at
 * least one finding and no fewer than it fixed. A gate whose open set did
 * not move records nothing: no progress is the stall stop's to judge.
 *
 * Every field is optional in a stored state: a file written before it
 * existed reads as no raise, no first launch and no history.
 */
import { parseMs } from "../../../../../shared/time.ts";
import { isRecord } from "../../../../../shared/guards.ts";

/** The diverging rounds in a row that stop a drive. */
export const DIVERGENCE_ROUNDS = 2;

/** The rounds of finding counts a state keeps. */
export const ROUND_FINDINGS_KEPT = 4;

/** One round gate's movement of the open review findings. */
export interface RoundFindings {
  /** The durable round count at the gate. */
  round: number;
  /** The head the gate read. */
  head: string;
  newFindings: number;
  fixedFindings: number;
  /** The findings open at the gate. */
  open: number;
}

/** The circuit breaker's stored fields (`DriveState`). */
export interface CircuitBreakerState {
  /** Rounds a person's override added to the round ceiling; never lowered. */
  ceilingRaised?: number;
  /** When the pull request was first driven; never reset. */
  firstDrivenAt?: string;
  /** Hours a person's override added to the wall-clock cap; never lowered. */
  wallClockRaisedHours?: number;
  /** The open findings the last round gate reported, by key. */
  openFindings?: string[];
  /** The last rounds' finding movement, oldest first. */
  roundFindings?: RoundFindings[];
  /** A person's answer to a circuit park that keeps the drive stopped, until their `--past-ceiling`. */
  circuitStop?: CircuitStop;
  /** The override answers a raise already consumed, by identity, so a re-read answer authorizes nothing twice. */
  usedOverrides?: string[];
}

/** A person's answer to a circuit park that keeps the drive stopped. */
export interface CircuitStop {
  /** The park answered: `round-ceiling` or `divergence-stop`. */
  key: string;
  /** The option chosen, or `a free answer`. */
  choice: string;
  /** When the re-arm read it. */
  at: string;
}

/** The fields the drive ledger carries, so a takeover keeps them. */
export interface LedgerCircuit {
  ceilingRaised?: number;
  firstDrivenAt?: string;
  wallClockRaisedHours?: number;
  circuitStop?: CircuitStop;
  usedOverrides?: string[];
}

/** The override answers a state remembers as consumed. */
export const USED_OVERRIDES_KEPT = 8;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const isHours = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

const isMoment = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(parseMs(v));

const isCircuitStop = (v: unknown): v is CircuitStop =>
  isRecord(v) &&
  typeof v.key === "string" &&
  typeof v.choice === "string" &&
  isMoment(v.at);

const isUsedOverrides = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((k) => typeof k === "string");

function isRoundFindings(v: unknown): v is RoundFindings {
  return (
    isRecord(v) &&
    isCount(v.round) &&
    typeof v.head === "string" &&
    isCount(v.newFindings) &&
    isCount(v.fixedFindings) &&
    isCount(v.open)
  );
}

/** The circuit breaker's fields: each absent, or well-formed. */
export function isOptionalCircuit(s: Record<string, unknown>): boolean {
  return (
    (s.ceilingRaised === undefined || isCount(s.ceilingRaised)) &&
    (s.firstDrivenAt === undefined || isMoment(s.firstDrivenAt)) &&
    (s.wallClockRaisedHours === undefined || isHours(s.wallClockRaisedHours)) &&
    (s.openFindings === undefined ||
      (Array.isArray(s.openFindings) &&
        s.openFindings.every((k) => typeof k === "string"))) &&
    (s.roundFindings === undefined ||
      (Array.isArray(s.roundFindings) &&
        s.roundFindings.every(isRoundFindings))) &&
    (s.circuitStop === undefined || isCircuitStop(s.circuitStop)) &&
    (s.usedOverrides === undefined || isUsedOverrides(s.usedOverrides))
  );
}

/** The ledger's circuit fields of a state: only those it holds. */
export function circuitLedgerFields(s: CircuitBreakerState): LedgerCircuit {
  return {
    ...(s.ceilingRaised ? { ceilingRaised: s.ceilingRaised } : {}),
    ...(s.firstDrivenAt === undefined
      ? {}
      : { firstDrivenAt: s.firstDrivenAt }),
    ...(s.wallClockRaisedHours
      ? { wallClockRaisedHours: s.wallClockRaisedHours }
      : {}),
    ...(s.circuitStop === undefined ? {} : { circuitStop: s.circuitStop }),
    ...(s.usedOverrides?.length ? { usedOverrides: s.usedOverrides } : {}),
  };
}

/** A ledger's circuit fields, as their own check reads them; the names of any that are malformed. */
export function malformedLedgerCircuit(
  l: Record<string, unknown>,
): (keyof LedgerCircuit)[] {
  const checks = {
    ceilingRaised: isCount,
    firstDrivenAt: isMoment,
    wallClockRaisedHours: isHours,
    circuitStop: isCircuitStop,
    usedOverrides: isUsedOverrides,
  } as const;
  return (Object.keys(checks) as (keyof LedgerCircuit)[]).filter(
    (name) => l[name] !== undefined && !checks[name](l[name]),
  );
}

/**
 * Seed `state` with a ledger's circuit fields, in place. The ledger is the
 * history being resumed: its raises replace this clone's, an absent one
 * meaning none. The first launch is the earlier of the two, so the wall
 * clock never restarts in another clone.
 */
export function seedCircuit(
  state: CircuitBreakerState,
  l: LedgerCircuit,
): void {
  const first = [state.firstDrivenAt, l.firstDrivenAt]
    .filter((m): m is string => m !== undefined)
    .sort((a, b) => parseMs(a) - parseMs(b))[0];
  delete state.ceilingRaised;
  delete state.wallClockRaisedHours;
  delete state.circuitStop;
  delete state.usedOverrides;
  if (l.circuitStop !== undefined) state.circuitStop = l.circuitStop;
  if (l.usedOverrides !== undefined) state.usedOverrides = l.usedOverrides;
  if (l.ceilingRaised !== undefined) state.ceilingRaised = l.ceilingRaised;
  if (l.wallClockRaisedHours !== undefined)
    state.wallClockRaisedHours = l.wallClockRaisedHours;
  if (first !== undefined) state.firstDrivenAt = first;
}

/** The round ceiling: the setting plus what overrides raised. */
export function roundCeiling(maxTotal: number, raised: number): number {
  return maxTotal + raised;
}

/** The heads counted before the one a drive resumes on. */
function countedBefore(spent: { rounds: number; headCounted: boolean }) {
  return spent.rounds - (spent.headCounted ? 1 : 0);
}

/** Whether the heads counted before the resumed one fill the ceiling, so the next round would pass it. */
export function atRoundCeiling(
  spent: { rounds: number; headCounted: boolean },
  ceiling: number,
): boolean {
  return countedBefore(spent) >= ceiling;
}

/**
 * The `ceilingRaised` an override leaves: once the ceiling is reached, the
 * ceiling becomes the heads counted before the resumed one plus `block`, so
 * the resumed head is the first of `block` more rounds; below the ceiling it
 * is unchanged. The block is counted from the heads already spent, so a
 * drive that was already past its ceiling (an upgraded one) still gets
 * exactly one block, never a block that is spent before the next round.
 * Never lowered.
 */
export function raisedCeiling(
  spent: { rounds: number; headCounted: boolean },
  maxTotal: number,
  raised: number,
  block: number,
): number {
  if (!atRoundCeiling(spent, roundCeiling(maxTotal, raised))) return raised;
  return Math.max(raised, countedBefore(spent) - maxTotal + block);
}

/** The hours driven since the first launch, or 0 before one. */
export function hoursDriven(
  firstDrivenAt: string | undefined,
  nowMs: number,
): number {
  if (firstDrivenAt === undefined) return 0;
  return Math.max(0, (nowMs - parseMs(firstDrivenAt)) / 3_600_000);
}

/** Whether the wall-clock cap, raised by what overrides added, is spent; never with no cap. */
export function wallClockSpent(
  capHours: number | null,
  raisedHours: number,
  driven: number,
): boolean {
  return capHours !== null && driven >= capHours + raisedHours;
}

/** The `wallClockRaisedHours` an override leaves: one more cap from now once spent; never lowered. */
export function raisedWallClock(
  capHours: number | null,
  raisedHours: number,
  driven: number,
): number {
  if (capHours === null || !wallClockSpent(capHours, raisedHours, driven))
    return raisedHours;
  return Math.max(raisedHours, driven);
}

/** The open findings a round gate reports, by key; `null` when it published no keys. */
export function openFindingKeys(
  status: Record<string, unknown>,
): string[] | null {
  const work = status.work;
  if (!isRecord(work)) return null;
  const threads = work.unresolvedThreadKeys;
  const summary = work.summaryUnaddressedKeys;
  if (!Array.isArray(threads) || !Array.isArray(summary)) return null;
  const keys = [...threads, ...summary];
  if (!keys.every((k) => typeof k === "string")) return null;
  return [...new Set(keys as string[])].sort((a, b) => a.localeCompare(b));
}

/**
 * The movement between the previous gate's open findings and this one's;
 * `null` when there is no previous gate. A gate where nothing moved is a
 * movement of none, which ends a streak of diverging rounds.
 */
export function findingMovement(
  previous: readonly string[] | undefined,
  now: readonly string[],
): { newFindings: number; fixedFindings: number } | null {
  if (previous === undefined) return null;
  const before = new Set(previous);
  const after = new Set(now);
  const newFindings = now.filter((k) => !before.has(k)).length;
  const fixedFindings = previous.filter((k) => !after.has(k)).length;
  return { newFindings, fixedFindings };
}

/** Whether a round raised at least one finding and no fewer than it fixed. */
export function diverges(r: RoundFindings): boolean {
  return r.newFindings >= 1 && r.newFindings >= r.fixedFindings;
}

/** The diverging rounds at the end of the history. */
export function divergingStreak(history: readonly RoundFindings[]): number {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!diverges(history[i] as RoundFindings)) break;
    streak += 1;
  }
  return streak;
}

/** Whether the history stops the drive: enough diverging rounds in a row, and a finding still open. */
export function divergenceStops(
  history: readonly RoundFindings[],
  rounds = DIVERGENCE_ROUNDS,
): boolean {
  const last = history[history.length - 1];
  return (
    last !== undefined && last.open >= 1 && divergingStreak(history) >= rounds
  );
}

/** The history with `entry` added, bounded to the last rounds. */
export function withRoundFindings(
  history: readonly RoundFindings[] | undefined,
  entry: RoundFindings,
): RoundFindings[] {
  return [...(history ?? []), entry].slice(-ROUND_FINDINGS_KEPT);
}

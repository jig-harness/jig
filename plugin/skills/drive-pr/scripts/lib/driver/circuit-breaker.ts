/**
 * The drive's economic circuit breaker, as the driver applies it
 * (`state/circuit-breaker.ts` holds the stored fields and the arithmetic):
 *
 *   - the round ceiling, checked by the round budget at launch and at every
 *     round's budget read: a pull request that has spent
 *     `drive.max_total_rounds` distinct reviewed heads, across every launch,
 *     re-arm and takeover, parks `round-ceiling`;
 *   - the wall-clock cap, `drive.max_wall_clock_hours` from the first launch,
 *     which parks the same way;
 *   - the divergence stop, checked at every round gate: rounds that each
 *     raise as many review findings as they fix park `divergence-stop`.
 *
 * Only a person raises a spent ceiling: `--past-ceiling` on the launch, or an
 * answer to the `round-ceiling` park that chooses the override.
 */
import { dirname, join } from "node:path";
import { currentIso, currentMs } from "../../../../../shared/time.ts";
import { fail, shellQuote } from "../cli.ts";
import {
  maxTotalRoundsSetting,
  maxWallClockHoursSetting,
  type SourcedSetting,
} from "../circuit-settings.ts";
import {
  type CircuitBreakerState,
  byCodeUnit,
  DIVERGENCE_ROUNDS,
  divergenceStops,
  findingMovement,
  USED_OVERRIDES_KEPT,
  hoursDriven,
  openFindingKeys,
  wallClockSpent,
  withRoundFindings,
} from "../state/circuit-breaker.ts";
import type { PendingVerdict } from "../state/pass-handoff.ts";
import { framedDecisionLines } from "../state/park-frame.ts";
import { openStore } from "../state/store.ts";
import { DRIVE_EXIT } from "../status/terminal-states.ts";
import {
  answerContinuesDivergence,
  answeredChoice,
  answerKeepsStopped,
  answerRaisesCeiling,
  type CeilingFacts,
  DIVERGENCE_PARK,
  divergenceDecision,
  parkCircuit,
  ROUND_CEILING_PARK,
  roundCeilingDecision,
} from "./circuit-park.ts";
import { driveTs } from "./paths.ts";
import { MAX_ROUNDS_EXIT } from "./settings.ts";

/** The limits a drive enforces beside its round budget. */
export interface CircuitLimits {
  pr: string;
  /** `drive.max_total_rounds` and where it was set. */
  maxTotal: SourcedSetting<number>;
  /** The rounds overrides added to the ceiling. */
  raised: number;
  /** The round ceiling: `maxTotal` plus `raised`. */
  ceiling: number;
  /** `drive.max_wall_clock_hours`, or `null` for no cap. */
  wallClock: SourcedSetting<number> | null;
  /** The hours overrides added to the wall-clock cap. */
  raisedHours: number;
  firstDrivenAt: string | undefined;
  /** One `--max-rounds` block: what an override adds. */
  block: number;
}

/** Both settings, read once; an unreadable one stops the drive naming it. */
export function readCircuitSettings(): {
  maxTotal: SourcedSetting<number>;
  wallClock: SourcedSetting<number> | null;
} {
  try {
    return {
      maxTotal: maxTotalRoundsSetting(),
      wallClock: maxWallClockHoursSetting(),
    };
  } catch (e) {
    return fail(1, `drive.ts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let overrideAnswered = false;
let overrideIdentity: string | undefined;

/** Whether this launch read a person's override answer to the `round-ceiling` park that no raise has consumed. */
export function pastCeilingAnswered(): boolean {
  return overrideAnswered;
}

/** The identity of the override answer this launch read, for the raise it authorizes to record. */
export function pastCeilingIdentity(): string | undefined {
  return overrideIdentity;
}

/** A person's override answers, by where and when they were given. */
function overrideAnswerIdentity(verdicts: readonly PendingVerdict[]): string {
  return verdicts
    .filter(answerRaisesCeiling)
    .flatMap((v) => v.answers.map((a) => `${v.key}|${a.url}|${a.at}`))
    .sort(byCodeUnit)
    .join(",");
}

/**
 * What a re-arm's answers mean to the circuit breaker. An override answer
 * to `round-ceiling` lets this launch raise the ceiling, as `--past-ceiling`
 * does (the raise happens only at the ceiling, so an answer read again by a
 * later arm raises nothing more); a "Continue driving" answer to
 * `divergence-stop` starts the count of diverging rounds again. Any other
 * answer to either park (finish by hand, re-scope, a note or a free answer)
 * is recorded as `circuitStop`, and the drive stays stopped for that person
 * without asking the same question again, until a person arms it with
 * `--past-ceiling`.
 */
export async function applyCircuitAnswers(
  pr: string,
  verdicts: readonly PendingVerdict[],
  dryRun: boolean,
): Promise<void> {
  if (verdicts.some(answerRaisesCeiling)) {
    const identity = overrideAnswerIdentity(verdicts);
    const used = (await openStore(pr)).read().state.usedOverrides ?? [];
    if (used.includes(identity)) {
      console.error(
        `re-arm: a person's answer to the ${ROUND_CEILING_PARK} park of PR #${pr} already raised its ceiling once; it authorizes nothing more.`,
      );
    } else {
      overrideAnswered = true;
      overrideIdentity = identity;
      console.error(
        `re-arm: a person's answer to the ${ROUND_CEILING_PARK} park allows PR #${pr} one more round budget past its ceiling.`,
      );
    }
  }
  const resume = verdicts.some(answerContinuesDivergence);
  const stop = verdicts.find(answerKeepsStopped);
  if (dryRun || (!resume && stop === undefined)) return;
  const store = await openStore(pr);
  await store.update((s) => {
    const next = { ...s };
    if (resume) {
      delete next.roundFindings;
      if (next.circuitStop?.key === DIVERGENCE_PARK) delete next.circuitStop;
    }
    if (stop !== undefined)
      next.circuitStop = {
        key: stop.key,
        choice: answeredChoice(stop),
        at: currentIso(),
      };
    return next;
  });
  if (resume)
    console.error(
      `re-arm: a person chose to continue driving PR #${pr} past the ${DIVERGENCE_PARK} park; the count of diverging rounds starts again.`,
    );
  if (stop !== undefined)
    console.error(
      `re-arm: a person answered the ${stop.key} park of PR #${pr} with ${answeredChoice(stop)}; the drive stays stopped for them.`,
    );
}

/**
 * The stop a person's answer to a circuit park asked for: print it and
 * return `INDETERMINATE`, a person's to act on, as the advisory-CI park's
 * manual answer does; `null` when no such answer is recorded. Only a
 * person's `--past-ceiling` lifts it.
 */
export async function personsCircuitStop(pr: string): Promise<number | null> {
  const stop = (await openStore(pr)).read().state.circuitStop;
  if (stop === undefined) return null;
  console.error(
    `circuit breaker: a person answered the ${stop.key} park of PR #${pr} with ${stop.choice} at ${stop.at}, so the drive stays stopped and asks nothing again. To drive it on, a person arms it with --past-ceiling: ${overrideCommand(pr)}`,
  );
  return DRIVE_EXIT.INDETERMINATE;
}

/** Lift a person's circuit stop: their `--past-ceiling` override. */
export async function clearCircuitStop(pr: string): Promise<void> {
  const store = await openStore(pr);
  if (store.read().state.circuitStop === undefined) return;
  await store.update((s) => {
    const next = { ...s };
    delete next.circuitStop;
    delete next.roundFindings;
    return next;
  });
  console.error(
    `re-arm: a person's --past-ceiling lifts the stop an earlier answer to a circuit park recorded on PR #${pr}.`,
  );
}

/** The first launch's moment, recorded now when the state holds none; never reset. */
export async function recordFirstDriven(
  pr: string,
  dryRun: boolean,
): Promise<string | undefined> {
  const store = await openStore(pr);
  const stored = store.read().state.firstDrivenAt;
  if (stored !== undefined || dryRun) return stored;
  let first: string | undefined;
  await store.update((s) => {
    first = s.firstDrivenAt ?? currentIso();
    return { ...s, firstDrivenAt: first };
  });
  return first;
}

/**
 * Store what a person's override raised, never lowering either field, and
 * clear the `round-ceiling` park the override settles.
 */
export async function storeRaise(
  pr: string,
  raised: number,
  raisedHours: number,
  answerIdentity?: string,
): Promise<void> {
  const store = await openStore(pr);
  await store.update((s) => ({
    ...s,
    ...(answerIdentity === undefined
      ? {}
      : {
          usedOverrides: [
            ...(s.usedOverrides ?? []).filter((k) => k !== answerIdentity),
            answerIdentity,
          ].slice(-USED_OVERRIDES_KEPT),
        }),
    ceilingRaised: Math.max(s.ceilingRaised ?? 0, raised),
    wallClockRaisedHours: Math.max(s.wallClockRaisedHours ?? 0, raisedHours),
    parked: s.parked.filter((p) => p.key !== ROUND_CEILING_PARK),
  }));
}

/** The arm command a person runs to drive past the ceiling. */
function overrideCommand(pr: string): string {
  const armDrive = join(dirname(driveTs), "arm-drive.ts");
  return `bun ${shellQuote(armDrive)} ${pr} --past-ceiling`;
}

/** The hours driven under `limits`, now. */
export function drivenHours(limits: CircuitLimits): number {
  return hoursDriven(limits.firstDrivenAt, currentMs());
}

/** Whether the wall-clock cap of `limits` is spent now. */
export function wallClockReached(limits: CircuitLimits): boolean {
  return wallClockSpent(
    limits.wallClock?.value ?? null,
    limits.raisedHours,
    drivenHours(limits),
  );
}

/**
 * A pass's deadline under the wall-clock cap: the configured deadline, cut to
 * the time the cap has left so an in-flight pass cannot outrun it (`0` there
 * means the pass has no deadline of its own). At least one second, since `0`
 * would disable the deadline; with no cap, the configured deadline.
 */
export function passDeadlineUnderCap(
  limits: CircuitLimits | undefined,
  configuredSec: number,
): number {
  if (limits === undefined || limits.wallClock === null) return configuredSec;
  const leftHours =
    limits.wallClock.value + limits.raisedHours - drivenHours(limits);
  const leftSec = Math.max(1, Math.ceil(leftHours * 3600));
  return configuredSec > 0 ? Math.min(configuredSec, leftSec) : leftSec;
}

/**
 * Stop on the round ceiling or the wall-clock cap: park `round-ceiling`,
 * print its decision and return `HITL_PARKED`; `MAX_ROUNDS` when the park
 * could not be recorded, so the drive stops all the same.
 */
export async function stopAtCeiling(
  limits: CircuitLimits,
  cause: CeilingFacts["cause"],
  rounds: number,
  dryRun: boolean,
): Promise<number> {
  const facts: CeilingFacts = {
    pr: limits.pr,
    rounds,
    hoursDriven: drivenHours(limits),
    ceiling: limits.ceiling,
    ceilingSource: limits.maxTotal.source,
    raised: limits.raised,
    wallClock:
      limits.wallClock === null
        ? null
        : {
            hours: limits.wallClock.value,
            source: limits.wallClock.source,
            raisedHours: limits.raisedHours,
          },
    cause,
    block: limits.block,
    overrideCommand: overrideCommand(limits.pr),
  };
  const decision = roundCeilingDecision(facts);
  console.error(
    `${cause === "rounds" ? "round ceiling" : "wall-clock cap"} reached on PR #${limits.pr}: parking ${ROUND_CEILING_PARK} for a person.`,
  );
  if (dryRun) {
    console.error(`(dry-run) would park ${ROUND_CEILING_PARK}.`);
    return DRIVE_EXIT.HITL_PARKED;
  }
  return await parked(limits.pr, ROUND_CEILING_PARK, decision);
}

/** Record a circuit park and print it; the exit the drive stops with. */
async function parked(
  pr: string,
  key: string,
  decision: Parameters<typeof parkCircuit>[2],
): Promise<number> {
  if (!(await parkCircuit(pr, key, decision))) {
    console.error(
      `circuit breaker: the ${key} park could not be recorded; stopping as MAX_ROUNDS so the drive does not spend another round.`,
    );
    return MAX_ROUNDS_EXIT;
  }
  const item = (await openStore(pr))
    .read()
    .state.parked.find((p) => p.key === key);
  if (item !== undefined)
    console.error(`\n${framedDecisionLines(item).join("\n")}\n`);
  return DRIVE_EXIT.HITL_PARKED;
}

/**
 * The round check: `counted` past the ceiling, or the wall-clock cap spent,
 * stops the drive; `null` lets the round run.
 */
export async function circuitStop(
  limits: CircuitLimits | undefined,
  counted: number,
  dryRun: boolean,
): Promise<number | null> {
  if (limits === undefined) return null;
  if (counted > limits.ceiling)
    return await stopAtCeiling(limits, "rounds", counted - 1, dryRun);
  if (wallClockReached(limits))
    return await stopAtCeiling(limits, "wall-clock", counted, dryRun);
  return null;
}

/**
 * The divergence stop, at a round gate that admitted a round: record how
 * the open findings moved since the last gate, and park `divergence-stop`
 * once enough rounds in a row diverged with a finding still open. A dry
 * run records nothing and parks nothing.
 */
export async function checkDivergence(
  pr: string,
  status: Record<string, unknown>,
  dryRun: boolean,
): Promise<number | null> {
  if (dryRun) return null;
  const keys = openFindingKeys(status);
  if (keys === null) return null;
  const head = String(
    (status.head as Record<string, unknown> | undefined)?.api ?? "",
  );
  const store = await openStore(pr);
  let history: CircuitBreakerState["roundFindings"] = [];
  await store.update((s) => {
    const moved = findingMovement(s.openFindings, keys);
    const next = { ...s, openFindings: keys };
    if (moved !== null)
      next.roundFindings = withRoundFindings(s.roundFindings, {
        round: s.rounds,
        head,
        ...moved,
        open: keys.length,
      });
    history = next.roundFindings ?? [];
    return next;
  });
  if (!divergenceStops(history, DIVERGENCE_ROUNDS)) return null;
  console.error(
    `divergence stop on PR #${pr}: the last ${DIVERGENCE_ROUNDS} rounds each raised as many review findings as they fixed; parking ${DIVERGENCE_PARK} for a person.`,
  );
  return await parked(
    pr,
    DIVERGENCE_PARK,
    divergenceDecision(pr, history, DIVERGENCE_ROUNDS),
  );
}

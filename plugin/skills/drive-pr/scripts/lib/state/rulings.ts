/**
 * The review arbiter's ruling on a thread, recorded with the thread's triage
 * state so the class a park names is the arbiter's ruling and not the
 * agent's claim.
 *
 * `drive-state.ts rule` records one ruling per thread key, read as JSON on
 * stdin (`{ "key", "verdict", "class"?, "humanDecision"?, "contextAt"? }`):
 *
 *  - `escalate` requires a class from `autonomy.park_classes`;
 *  - `humanDecision: true` (the fix would change a value the pull request
 *    records as a person's decision, or a rule inside a human-decided span)
 *    is an `escalate` whose class is always `human-decision`: another class
 *    is refused, and a missing one is set;
 *  - any other verdict carries no class;
 *  - `contextAt` (ISO 8601) is the time the pass gathered the context it
 *    handed the arbiter, taken before the arbiter runs: a fix-now ruling
 *    without it never lifts the person-thread refusal.
 *
 * `park --kind thread` then refuses a class other than the recorded one, and
 * refuses to park a thread the arbiter ruled on with any verdict but
 * `escalate` (`parkRefusal`). Optional in a stored state: a state written
 * before rulings were recorded reads as none.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { parkClasses } from "../../../../../shared/autonomy.ts";
import { layeredConfig } from "../../../../../shared/consumer.ts";
import { fail } from "../cli.ts";
import type { DriveState } from "./schema.ts";
import type { StateStore } from "./store.ts";
import {
  currentIso,
  currentMs,
  isCalendarDate,
  isoFromMs,
  parseMs,
} from "../../../../../shared/time.ts";

/** The arbiter's verdicts (`plugin/agents/review-arbiter.md`). */
export const ARBITER_VERDICTS = [
  "fix-now",
  "rejected",
  "wont-fix",
  "defer",
  "escalate",
] as const;
type Verdict = (typeof ARBITER_VERDICTS)[number];

/** The class the arbiter must give a call that touches a person's decision. */
export const HUMAN_DECISION_CLASS = "human-decision";

export interface ArbiterRuling {
  key: string;
  verdict: Verdict;
  /** Present exactly when the verdict is `escalate`. */
  class?: string;
  humanDecision: boolean;
  /**
   * When the pass gathered the context it handed the arbiter, ISO 8601; the
   * person-thread check lifts only for words not newer than this.
   */
  contextAt?: string;
  round: number;
  at: string;
}

function isRuling(v: unknown): v is ArbiterRuling {
  return (
    isRecord(v) &&
    typeof v.key === "string" &&
    v.key !== "" &&
    !/[\n\r]/.test(v.key) &&
    (ARBITER_VERDICTS as readonly unknown[]).includes(v.verdict) &&
    (v.verdict === "escalate"
      ? typeof v.class === "string" && v.class !== ""
      : v.class === undefined) &&
    typeof v.humanDecision === "boolean" &&
    (v.contextAt === undefined || typeof v.contextAt === "string") &&
    (!v.humanDecision || v.class === HUMAN_DECISION_CLASS) &&
    typeof v.round === "number" &&
    typeof v.at === "string"
  );
}

export function isOptionalRulings(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isRuling));
}

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;

/** The instant of an ISO 8601 time with an explicit zone and a real calendar date, else `NaN`. */
function strictTime(text: string): number {
  const m = ISO_WITH_ZONE.exec(text);
  if (m === null) return NaN;
  const [h, mi, s] = m.slice(4, 7).map(Number) as [number, number, number];
  const real = isCalendarDate(text.slice(0, 10)) && h < 24 && mi < 60 && s < 60;
  return real ? parseMs(text) : NaN;
}

/** Why a `contextAt` is not a past ISO 8601 time with a zone, or `null`. */
function contextFault(contextAt: unknown): string | null {
  if (contextAt === undefined) return null;
  const at = typeof contextAt === "string" ? strictTime(contextAt) : NaN;
  if (Number.isNaN(at))
    return "contextAt must be a calendar ISO 8601 time with an explicit zone when given";
  return at > currentMs() ? "contextAt must not be in the future" : null;
}

/**
 * Why `input`'s fields are not of their types, or `null`. A field given with
 * the wrong type is refused, never read as absent: an absent
 * `humanDecision` is no, and a `"yes"` read the same way would be the
 * permissive answer.
 */
function shapeFault(input: Record<string, unknown>): string | null {
  const { key, verdict, humanDecision, class: cls, contextAt } = input;
  const timeFault = contextFault(contextAt);
  if (timeFault !== null) return timeFault;
  if (humanDecision !== undefined && typeof humanDecision !== "boolean")
    return "humanDecision must be true or false when given";
  if (cls !== undefined && typeof cls !== "string")
    return "class must be a class name when given";
  if (typeof key !== "string" || key === "" || /[\n\r]/.test(key))
    return "key must be one thread node id on one line";
  if (!(ARBITER_VERDICTS as readonly unknown[]).includes(verdict))
    return `verdict must be one of ${ARBITER_VERDICTS.join(", ")}`;
  return null;
}

/** The ruling `input` describes, or why it cannot be recorded. */
function rulingFrom(
  input: Record<string, unknown>,
  classes: readonly string[],
): Omit<ArbiterRuling, "round" | "at"> | string {
  const fault = shapeFault(input);
  if (fault !== null) return fault;
  const contextAt =
    typeof input.contextAt === "string"
      ? { contextAt: isoFromMs(parseMs(input.contextAt)) }
      : {};
  const key = input.key as string;
  const verdict = input.verdict as Verdict;
  const humanDecision = input.humanDecision === true;
  if (humanDecision && verdict !== "escalate")
    return "a call that touches a person's decision is only ever escalated";
  const given = input.class as string | undefined;
  if (humanDecision && given !== undefined && given !== HUMAN_DECISION_CLASS)
    return `a call that touches a person's decision has the class ${HUMAN_DECISION_CLASS}, not '${given}'`;
  const cls = humanDecision ? HUMAN_DECISION_CLASS : given;
  if (verdict !== "escalate")
    return cls === undefined
      ? { key, verdict, humanDecision, ...contextAt }
      : `a ${verdict} ruling carries no class`;
  if (cls === undefined || !classes.includes(cls))
    return `an escalate ruling needs its class, one of: ${classes.join(", ")}`;
  return { key, verdict: "escalate", class: cls, humanDecision, ...contextAt };
}

/** `rule [PR]`: record the arbiter's ruling on one thread. */
export async function recordRuling(
  store: StateStore,
  raw: string,
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    fail(
      2,
      'rule reads one JSON object on stdin: {"key", "verdict", "class"?, "humanDecision"?, "contextAt"?}',
    );
  }
  if (!isRecord(input)) fail(2, "rule: stdin is not a JSON object");
  const ruling = rulingFrom(input, parkClasses(layeredConfig()));
  if (typeof ruling === "string") fail(2, `rule: ${ruling}`);
  await store.update((s) => ({
    ...s,
    rulings: [
      ...(s.rulings ?? []).filter((r) => r.key !== ruling.key),
      { ...ruling, round: s.rounds, at: currentIso() },
    ],
  }));
  return 0;
}

/**
 * Why a park of `key` under `parkClass` contradicts the arbiter's recorded
 * ruling, or `null` when it does not (or no ruling is recorded). `classes`
 * are the park classes in force now. A ruling whose class is no longer among
 * them (recorded while the policy read, before it failed closed to the kept
 * classes) may still be parked under `human-decision`: the class it names
 * would be refused, and a refusal of both would leave the thread with no
 * way to reach a person.
 */
export function parkRefusal(
  s: DriveState,
  key: string,
  kind: string,
  parkClass: string,
  classes: readonly string[],
  unreadablePolicy = false,
): string | null {
  if (kind !== "thread") return null;
  const ruling = (s.rulings ?? []).find((r) => r.key === key);
  if (ruling === undefined) return null;
  // An unreadable policy parks every decision under `human-decision`,
  // whatever an earlier ruling recorded.
  if (unreadablePolicy && parkClass === "human-decision") return null;
  if (ruling.verdict !== "escalate")
    return `the arbiter ruled '${ruling.verdict}' on ${key}: act on that ruling, or record a new one with 'rule' before parking`;
  if (ruling.class === parkClass) return null;
  if (
    parkClass === "human-decision" &&
    (ruling.class === undefined || !classes.includes(ruling.class))
  )
    return null;
  return `the arbiter ruled the class '${ruling.class}' for ${key}: park under that class, not '${parkClass}'`;
}

/**
 * The review arbiter's ruling on a thread, recorded with the thread's triage
 * state so the class a park names is the arbiter's ruling and not the
 * agent's claim.
 *
 * `drive-state.ts rule` records one ruling per thread key, read as JSON on
 * stdin (`{ "key", "verdict", "class"?, "humanDecision"? }`):
 *
 *  - `escalate` requires a class from `autonomy.park_classes`;
 *  - `humanDecision: true` (the fix would change a value the pull request
 *    records as a person's decision, or a rule inside a human-decided span)
 *    is an `escalate` whose class is always `human-decision`: another class
 *    is refused, and a missing one is set;
 *  - any other verdict carries no class.
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
    (!v.humanDecision || v.class === HUMAN_DECISION_CLASS) &&
    typeof v.round === "number" &&
    typeof v.at === "string"
  );
}

export function isOptionalRulings(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isRuling));
}

/** The ruling `input` describes, or why it cannot be recorded. */
function rulingFrom(
  input: Record<string, unknown>,
  classes: readonly string[],
): Omit<ArbiterRuling, "round" | "at"> | string {
  const { key, verdict } = input;
  const humanDecision = input.humanDecision === true;
  if (typeof key !== "string" || key === "" || /[\n\r]/.test(key))
    return "key must be one thread node id on one line";
  if (!(ARBITER_VERDICTS as readonly unknown[]).includes(verdict))
    return `verdict must be one of ${ARBITER_VERDICTS.join(", ")}`;
  if (humanDecision && verdict !== "escalate")
    return "a call that touches a person's decision is only ever escalated";
  const given = typeof input.class === "string" ? input.class : undefined;
  if (humanDecision && given !== undefined && given !== HUMAN_DECISION_CLASS)
    return `a call that touches a person's decision has the class ${HUMAN_DECISION_CLASS}, not '${given}'`;
  const cls = humanDecision ? HUMAN_DECISION_CLASS : given;
  if (verdict !== "escalate")
    return cls === undefined
      ? { key, verdict: verdict as Verdict, humanDecision }
      : `a ${String(verdict)} ruling carries no class`;
  if (cls === undefined || !classes.includes(cls))
    return `an escalate ruling needs its class, one of: ${classes.join(", ")}`;
  return { key, verdict: "escalate", class: cls, humanDecision };
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
      'rule reads one JSON object on stdin: {"key", "verdict", "class"?, "humanDecision"?}',
    );
  }
  if (!isRecord(input)) fail(2, "rule: stdin is not a JSON object");
  const ruling = rulingFrom(input, parkClasses(layeredConfig()));
  if (typeof ruling === "string") fail(2, `rule: ${ruling}`);
  await store.update((s) => ({
    ...s,
    rulings: [
      ...(s.rulings ?? []).filter((r) => r.key !== ruling.key),
      { ...ruling, round: s.rounds, at: new Date().toISOString() },
    ],
  }));
  return 0;
}

/**
 * Why a park of `key` under `parkClass` contradicts the arbiter's recorded
 * ruling, or `null` when it does not (or no ruling is recorded).
 */
export function parkRefusal(
  s: DriveState,
  key: string,
  kind: string,
  parkClass: string,
): string | null {
  if (kind !== "thread") return null;
  const ruling = (s.rulings ?? []).find((r) => r.key === key);
  if (ruling === undefined) return null;
  if (ruling.verdict !== "escalate")
    return `the arbiter ruled '${ruling.verdict}' on ${key}: act on that ruling, or record a new one with 'rule' before parking`;
  return ruling.class === parkClass
    ? null
    : `the arbiter ruled the class '${ruling.class}' for ${key}: park under that class, not '${parkClass}'`;
}

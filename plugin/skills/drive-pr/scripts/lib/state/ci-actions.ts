/** Optional CI telemetry stays separate from the control events older readers validate. */
import { isRecord } from "../../../../../shared/guards.ts";
import { redact } from "../../../../../shared/redact.ts";
import { currentIso, parseMs } from "../../../../../shared/time.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

export interface CiAction {
  at: string;
  round: number;
  action: "rerun" | "repair";
  detail: string;
}
export const diagnosisPrefix = (head: string) => `diagnosis: head ${head}: `;
export const diagnosisStartedPrefix = (head: string) =>
  `diagnose: head ${head}: `;
export const diagnosisSkippedPrefix = (head: string) =>
  `diagnose-skipped: head ${head}: `;

/** The latest escalation at `head`: a started, recorded or skipped diagnosis. */
export function lastDiagnosisAt(
  actions: readonly CiAction[],
  head: string,
): CiAction | undefined {
  return actions.findLast(
    (a) =>
      a.action === "repair" &&
      (a.detail.startsWith(diagnosisPrefix(head)) ||
        a.detail.startsWith(diagnosisStartedPrefix(head)) ||
        a.detail.startsWith(diagnosisSkippedPrefix(head))),
  );
}

/**
 * What the escalation at `head` left: its recorded diagnosis, a note that the
 * session recorded none, or `undefined` when none ran or it was skipped.
 */
export function diagnosisOutcome(
  actions: readonly CiAction[],
  head: string,
): string | undefined {
  const last = lastDiagnosisAt(actions, head);
  if (
    last === undefined ||
    last.detail.startsWith(diagnosisSkippedPrefix(head))
  )
    return undefined;
  return last.detail.startsWith(diagnosisPrefix(head))
    ? last.detail.slice(diagnosisPrefix(head).length)
    : "the diagnosing session recorded no outcome";
}

function diagnosisHead(action: CiAction): string | undefined {
  if (action.action !== "repair") return undefined;
  const match = /^diagnos(?:is|e(?:-skipped)?): head (\S+): /.exec(
    action.detail,
  );
  return match?.[1];
}

export function diagnosisDetail(
  actions: readonly CiAction[],
): string | undefined {
  return actions
    .findLast(
      (a) => a.action === "repair" && a.detail.startsWith("diagnosis: head "),
    )
    ?.detail.replace(/^diagnosis: head \S+: /, "");
}

/** Keep the latest diagnosis receipt for every head when telemetry is trimmed. */
export function retainedDiagnosis(actions: readonly CiAction[]): CiAction[] {
  const latest = new Map<string, CiAction>();
  for (const action of actions) {
    const head = diagnosisHead(action);
    if (head !== undefined) {
      latest.delete(head);
      latest.set(head, action);
    }
  }
  return [...latest.values()];
}

const ACTION_LIMIT = 10;
const DETAIL_LIMIT = 1024;

/** Apply the shared bound after any transformation of telemetry detail. */
export function boundedCiDetail(detail: string): string {
  return redact(detail).slice(0, DETAIL_LIMIT);
}

function isCiAction(v: unknown): v is CiAction {
  return (
    isRecord(v) &&
    typeof v.at === "string" &&
    Number.isFinite(parseMs(v.at)) &&
    Number.isSafeInteger(v.round) &&
    Number(v.round) >= 0 &&
    (v.action === "rerun" || v.action === "repair") &&
    typeof v.detail === "string" &&
    v.detail.length > 0 &&
    v.detail.length <= DETAIL_LIMIT
  );
}

/** Preserve per-head diagnosis control receipts ahead of disposable telemetry. */
export function boundedCiActions(actions: readonly CiAction[]): CiAction[] {
  const diagnoses = retainedDiagnosis(actions).slice(-ACTION_LIMIT);
  const telemetry = actions.filter(
    (action) => diagnosisHead(action) === undefined,
  );
  const telemetryAllowance = ACTION_LIMIT - diagnoses.length;
  return [
    ...diagnoses,
    ...(telemetryAllowance === 0 ? [] : telemetry.slice(-telemetryAllowance)),
  ];
}

export function isOptionalCiActions(v: unknown): boolean {
  return (
    v === undefined ||
    (Array.isArray(v) && v.length <= ACTION_LIMIT && v.every(isCiAction))
  );
}

/** The CLI keeps its record-event form while writing additive telemetry. */
export async function recordCiAction(
  store: StateStore,
  cause: unknown,
): Promise<number> {
  if (typeof cause !== "string")
    fail(2, "CI action needs rerun: or repair: detail");
  const match = /^(rerun|repair): (.+)$/su.exec(cause);
  if (match === null) fail(2, "CI action needs rerun: or repair: detail");
  await store.update((s) => {
    const action = {
      at: currentIso(),
      round: s.rounds,
      action: match[1],
      detail: boundedCiDetail(match[2] ?? ""),
    };
    if (!isCiAction(action)) fail(2, "CI action needs a nonempty detail");
    return {
      ...s,
      ciActions: boundedCiActions([...(s.ciActions ?? []), action]),
    };
  });
  return 0;
}

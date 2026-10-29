/**
 * Every autonomous decision is recorded where a person can find and reverse
 * it, in the same step that takes it: a thread reply with the outcome token
 * and its rationale for a review finding, a decision-record comment for a
 * `decide` ruling, the issue body for an issue filed, the `## Deferred`
 * section for a deferral, and, for each but the thread reply, an entry here. `drive-state.ts record-decision` appends the entry; the
 * handoff file and the drive ledger list the entries under
 * `## Decisions taken unattended`, with the autonomy level each was taken
 * under, its class, where its record is and how to reverse it.
 *
 * An entry with no record is accepted and counted as a defect in the round
 * report, the same way an unparked escalation is one: the decision happened,
 * and hiding it would be worse than naming the missing record.
 *
 * Optional in a stored state, like `takeovers`: a state written before the
 * field existed reads as no decisions.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import {
  AUTONOMY_LEVELS,
  type AutonomyLevel,
  currentAutonomy,
} from "../../../../../shared/autonomy.ts";
import { fail } from "../cli.ts";
import type { StateStore } from "./store.ts";

/**
 * The decisions an agent takes and records, one per row of the autonomy
 * table that the agent may take: filing an issue a skill needs, deferring a
 * finding into the pull request's `## Deferred` section, and a technical
 * choice `decide` rules, reversible inside one pull request or after the
 * evidence an underdetermined call lacked was gathered.
 */
export const DECISION_CLASSES = [
  "file-issue",
  "defer-without-tracker",
  "decide-reversible",
  "decide-underdetermined",
] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

export interface UnattendedDecision {
  at: string;
  round: number;
  level: AutonomyLevel;
  class: DecisionClass;
  /** What was decided, in one line. */
  what: string;
  /** The url of the record a person reads and reverses it from; `''` when none. */
  record: string;
  /** How to reverse it, in one line. */
  reverse: string;
}

const oneLine = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && !/[\n\r]/.test(v);

/**
 * A record a person can open: an `http(s)` url with a host and no user
 * information, or `''` for none. A placeholder (`none`, `TODO`, `#`) is
 * neither, so it cannot pass a missing record off as a present one. User
 * information is refused because it is a credential or an address: the
 * ledger's redaction would replace it and leave a url this check refuses, so
 * the ledger could not be read back.
 */
export function isRecordUrl(v: unknown): v is string {
  if (v === "") return true;
  if (typeof v !== "string" || /\s/.test(v) || !URL.canParse(v)) return false;
  const url = new URL(v);
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.host !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function isUnattendedDecision(v: unknown): v is UnattendedDecision {
  return (
    isRecord(v) &&
    typeof v.at === "string" &&
    Number.isFinite(Date.parse(v.at)) &&
    typeof v.round === "number" &&
    Number.isInteger(v.round) &&
    v.round >= 0 &&
    (AUTONOMY_LEVELS as readonly unknown[]).includes(v.level) &&
    (DECISION_CLASSES as readonly unknown[]).includes(v.class) &&
    oneLine(v.what) &&
    isRecordUrl(v.record) &&
    oneLine(v.reverse)
  );
}

export function isOptionalDecisions(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isUnattendedDecision));
}

/** How many recorded decisions have no record a person can reverse them from. */
export function decisionsWithoutRecord(
  decisions: readonly UnattendedDecision[],
): number {
  return decisions.filter((d) => d.record === "").length;
}

/** The `## Decisions taken unattended` section's lines (Markdown). */
export function decisionsSection(
  decisions: readonly UnattendedDecision[],
): string[] {
  const lines = ["## Decisions taken unattended", ""];
  if (decisions.length === 0) return [...lines, "_None._"];
  for (const d of decisions)
    lines.push(
      `- **${d.class}** at \`${d.level}\`, round ${d.round}: ${d.what} · record: ${d.record === "" ? "**none (a defect)**" : d.record} · to reverse: ${d.reverse}`,
    );
  const missing = decisionsWithoutRecord(decisions);
  if (missing > 0)
    lines.push(
      "",
      `${missing} decision(s) without a record: a defect the round report counts.`,
    );
  return lines;
}

/**
 * `record-decision [PR]`: append one decision, read as JSON on stdin
 * (`{ "class", "what", "reverse", "record"? }`), at the level in force now.
 */
export async function recordDecision(
  store: StateStore,
  raw: string,
): Promise<number> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    fail(
      2,
      'record-decision reads one JSON object on stdin: {"class", "what", "reverse", "record"?}',
    );
  }
  if (!isRecord(input)) fail(2, "record-decision: stdin is not a JSON object");
  const level = currentAutonomy().level;
  await store.update((s) => {
    const entry = {
      at: new Date().toISOString(),
      round: s.rounds,
      level,
      class: input.class,
      what: input.what,
      record: input.record ?? "",
      reverse: input.reverse,
    };
    if (!isUnattendedDecision(entry))
      fail(
        2,
        `record-decision: class must be one of ${DECISION_CLASSES.join(", ")}; what and reverse one nonempty line each; record an http(s) url without user information, or absent`,
      );
    return { ...s, decisions: [...(s.decisions ?? []), entry] };
  });
  if (input.record === undefined || input.record === "")
    console.error(
      "record-decision: recorded without a record a person can reverse it from; the round report counts it as a defect.",
    );
  return 0;
}

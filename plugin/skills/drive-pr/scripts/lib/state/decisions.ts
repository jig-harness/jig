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
 * A **provisional** decision is one only the `wide` level takes: an arbiter
 * escalation answered with a provisional reply outcome
 * (`provisional-reply`), or a choice `decide`'s last row would escalate,
 * decided (`decide-provisional`). It carries the key a person reverses it
 * on (the thread, or the decision record's key), and is refused at any
 * other level. A person reverses it by commenting on that thread, or on the
 * pull request with a line `answer <key>: …`, as an owner, member or
 * collaborator; the next round records the reversal here (`reverse-decision`)
 * and parks the item under `human-thread`. An unresolve alone is not a
 * reversal: the forge records it without an author.
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
import { PROVISIONAL_OUTCOMES } from "../outcome.ts";
import type { StateStore } from "./store.ts";

/**
 * The decisions an agent takes and records, one per row of the autonomy
 * table that the agent may take: filing an issue a skill needs, deferring a
 * finding into the pull request's `## Deferred` section, a technical choice
 * `decide` rules, reversible inside one pull request or after the evidence
 * an underdetermined call lacked was gathered, and the two provisional
 * decisions only `wide` takes.
 */
export const DECISION_CLASSES = [
  "file-issue",
  "defer-without-tracker",
  "decide-reversible",
  "decide-underdetermined",
  "decide-provisional",
  "provisional-reply",
] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

/** The classes only `wide` takes, each reversible by a person's comment. */
export const PROVISIONAL_CLASSES: ReadonlySet<DecisionClass> = new Set([
  "decide-provisional",
  "provisional-reply",
]);

/** A person's reversal of a provisional decision. */
export interface Reversal {
  at: string;
  /** The login of the owner, member or collaborator who commented. */
  by: string;
  url: string;
}

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
  /** A provisional decision's thread, or its decision record's key. */
  key?: string;
  /** A provisional reply's outcome: `rejected`, `wont-fix` or `deferred`. */
  outcome?: string;
  /** Set once a person reversed a provisional decision. */
  reversed?: Reversal;
}

const oneLine = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "" && !/[\n\r]/.test(v);

function isReversal(v: unknown): v is Reversal {
  return (
    isRecord(v) &&
    typeof v.at === "string" &&
    Number.isFinite(Date.parse(v.at)) &&
    typeof v.by === "string" &&
    typeof v.url === "string"
  );
}

/** A provisional entry's own fields: a key, an admissible outcome, a reversal. */
function provisionalFieldsHold(v: Record<string, unknown>): boolean {
  if (!PROVISIONAL_CLASSES.has(v.class as DecisionClass))
    return (
      v.key === undefined && v.outcome === undefined && v.reversed === undefined
    );
  return (
    oneLine(v.key) &&
    !/\s/.test(v.key) &&
    (v.class === "provisional-reply"
      ? PROVISIONAL_OUTCOMES.has(v.outcome as never)
      : v.outcome === undefined) &&
    (v.reversed === undefined || isReversal(v.reversed))
  );
}

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
    oneLine(v.reverse) &&
    provisionalFieldsHold(v)
  );
}

export function isOptionalDecisions(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every(isUnattendedDecision));
}

/** Whether a decision is provisional (only `wide` takes those). */
export function isProvisional(d: UnattendedDecision): boolean {
  return PROVISIONAL_CLASSES.has(d.class);
}

/** The provisional decisions no person has reversed yet. */
export function standingProvisional(
  decisions: readonly UnattendedDecision[],
): UnattendedDecision[] {
  return decisions.filter((d) => isProvisional(d) && d.reversed === undefined);
}

/**
 * The parked keys that hold a reversed provisional decision. The round gate
 * counts these as awaiting a person on their own: a reversed `decide`
 * ruling's key is no thread id or summary fingerprint, and a reversed
 * reply's thread may be resolved again, so neither park would otherwise
 * keep the drive from converging over the person's unanswered comment.
 */
export function reversalParkedKeys(
  parked: ReadonlyArray<{ key: string }>,
  decisions: readonly UnattendedDecision[],
): string[] {
  const reversed = new Set(
    decisions
      .filter((d) => isProvisional(d) && d.reversed !== undefined)
      .map((d) => d.key ?? ""),
  );
  return parked.map((p) => p.key).filter((k) => reversed.has(k));
}

/**
 * `parked-keys [PR]`: every parked key, one per line;
 * `reversal-parked-keys [PR]`: only `reversalParkedKeys`.
 */
export function printParkedKeys(
  state: {
    parked: ReadonlyArray<{ key: string }>;
    decisions?: readonly UnattendedDecision[];
  },
  reversalsOnly: boolean,
): number {
  const keys = reversalsOnly
    ? reversalParkedKeys(state.parked, state.decisions ?? [])
    : state.parked.map((p) => p.key);
  for (const key of keys) process.stdout.write(`${key}\n`);
  return 0;
}

/** How many recorded decisions have no record a person can reverse them from. */
export function decisionsWithoutRecord(
  decisions: readonly UnattendedDecision[],
): number {
  return decisions.filter((d) => d.record === "").length;
}

/** One decision as a list item: provisional ones say so, and whether reversed. */
export function decisionLine(d: UnattendedDecision): string {
  const tag = isProvisional(d)
    ? ` · **provisional**${d.outcome === undefined ? "" : ` \`${d.outcome}\``} on \`${d.key}\`${d.reversed === undefined ? "" : ` · reversed by ${d.reversed.by} at ${d.reversed.at} (${d.reversed.url})`}`
    : "";
  return `- **${d.class}** at \`${d.level}\`, round ${d.round}: ${d.what}${tag} · record: ${d.record === "" ? "**none (a defect)**" : d.record} · to reverse: ${d.reverse}`;
}

/** The `## Decisions taken unattended` section's lines (Markdown), provisional ones first. */
export function decisionsSection(
  decisions: readonly UnattendedDecision[],
): string[] {
  const lines = ["## Decisions taken unattended", ""];
  if (decisions.length === 0) return [...lines, "_None._"];
  const ordered = [
    ...decisions.filter(isProvisional),
    ...decisions.filter((d) => !isProvisional(d)),
  ];
  for (const d of ordered) lines.push(decisionLine(d));
  const missing = decisionsWithoutRecord(decisions);
  if (missing > 0)
    lines.push(
      "",
      `${missing} decision(s) without a record: a defect the round report counts.`,
    );
  return lines;
}

function parseInput(raw: string, usage: string): Record<string, unknown> {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    fail(2, usage);
  }
  if (!isRecord(input)) fail(2, `${usage} (stdin is not a JSON object)`);
  return input;
}

/**
 * `record-decision [PR]`: append one decision, read as JSON on stdin
 * (`{ "class", "what", "reverse", "record"?, "level"?, "key"?, "outcome"?,
 * "posted"? }`), at the `level` the caller captured, else the level in force
 * now. A provisional class is refused unless that level is `wide`;
 * `posted: true` records a provisional reply already posted, at `wide`,
 * whatever the level now.
 */
export async function recordDecision(
  store: StateStore,
  raw: string,
): Promise<number> {
  const input = parseInput(
    raw,
    'record-decision reads one JSON object on stdin: {"class", "what", "reverse", "record"?, "level"?, "key"?, "outcome"?}',
  );
  // `posted: true` completes a provisional reply already on its thread,
  // posted at `wide` (its text says so): recording it whatever the level is
  // now keeps it under the boundary sweep and in the report once an
  // off-hours window closes between the post and the record.
  const completing =
    input.posted === true && input.class === "provisional-reply";
  // Otherwise the level the action was authorized under, when the caller
  // captured it: the configuration can change between the action and this
  // command.
  const level = completing ? "wide" : (input.level ?? currentAutonomy().level);
  if (PROVISIONAL_CLASSES.has(input.class as DecisionClass) && level !== "wide")
    fail(
      3,
      `record-decision: a ${String(input.class)} decision is taken only at the wide autonomy level, and this one runs at ${String(level)}; escalate or park it instead.`,
    );
  await store.update((s) => {
    const entry = {
      at: new Date().toISOString(),
      round: s.rounds,
      level,
      class: input.class,
      what: input.what,
      record: input.record ?? "",
      reverse: input.reverse,
      ...(input.key === undefined ? {} : { key: input.key }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    };
    if (!isUnattendedDecision(entry))
      fail(
        2,
        `record-decision: class must be one of ${DECISION_CLASSES.join(", ")}; level, when given, one of ${AUTONOMY_LEVELS.join(", ")}; what and reverse one nonempty line each; record an http(s) url without user information, or absent; a provisional class needs a key, and provisional-reply an outcome of rejected, wont-fix or deferred`,
      );
    return { ...s, decisions: [...(s.decisions ?? []), entry] };
  });
  if (input.record === undefined || input.record === "")
    console.error(
      "record-decision: recorded without a record a person can reverse it from; the round report counts it as a defect.",
    );
  return 0;
}

/**
 * `reverse-decision [PR]`: record a person's reversal of the standing
 * provisional decision on a key, read as JSON on stdin
 * (`{ "key", "by", "url", "at" }`). Prints `reversed` or `none` (no standing
 * provisional decision on that key, which includes one already reversed).
 */
export async function reverseDecision(
  store: StateStore,
  raw: string,
): Promise<number> {
  const input = parseInput(
    raw,
    'reverse-decision reads one JSON object on stdin: {"key", "by", "url", "at"}',
  );
  const reversal = { at: input.at, by: input.by, url: input.url };
  if (!oneLine(input.key) || !isReversal(reversal))
    fail(
      2,
      "reverse-decision: key, by and url are strings and at an ISO-8601 instant",
    );
  let found = false;
  await store.update((s) => ({
    ...s,
    decisions: (s.decisions ?? []).map((d) => {
      if (found || d.key !== input.key || !isProvisional(d) || d.reversed)
        return d;
      found = true;
      return { ...d, reversed: reversal };
    }),
  }));
  console.log(found ? "reversed" : "none");
  return 0;
}

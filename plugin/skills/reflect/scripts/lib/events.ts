/**
 * Reflection events: the two record types the store holds, their checks,
 * their ids, and the state computed from them.
 *
 * The store is an append-only log. Nothing that looks like state (a
 * finding's status, a class's recurrence count) is stored: it is computed
 * here from the set of distinct events, so it does not depend on which store
 * holds them, the order they come back in, or how many copies of one event a
 * store keeps.
 */
import { createHash, randomBytes } from "node:crypto";
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";

export const EVENT_VERSION = 1;

export const KINDS = ["error", "opportunity"] as const;
export const SEVERITIES = ["high", "medium", "low"] as const;
export const DECISIONS = [
  "approved",
  "implemented",
  "deferred",
  "dismissed",
  "escalated",
] as const;

export type Kind = (typeof KINDS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type DecisionKind = (typeof DECISIONS)[number];
export type Status = "open" | DecisionKind;

export interface Harness {
  name: string | null;
  version: string | null;
  entrypoint: string | null;
  wrapper: string | null;
}

export interface Session {
  jig_version: string | null;
  skills: string[];
  harness: Harness | null;
  model: string | null;
  mode: string | null;
  stated: string[];
}

export interface Change {
  repository: string;
  branch: string | null;
  pull_request: number | null;
  issue: string | null;
}

export type Target =
  | { scope: "repository"; name: string }
  | { scope: "tool"; tool: string; name: string };

export interface FindingEvent {
  v: number;
  type: "finding";
  id: string;
  at: string;
  session: Session;
  change: Change;
  kind: Kind;
  severity: Severity;
  class: string;
  target: Target;
  title: string;
  description: string;
  suggested_fix: string;
  time_cost_minutes?: number;
}

export interface DecisionEvent {
  v: number;
  type: "decision";
  id: string;
  at: string;
  session: Session;
  finding: string;
  decision: DecisionKind;
  reason: string;
  commit?: string;
  pull_request?: number;
  issue?: string;
}

export type ReflectionEvent = FindingEvent | DecisionEvent;

/** An event as `list` returns it: the parsed value and its stored text. */
export interface StoredEvent {
  event: ReflectionEvent;
  text: string;
}

const TIME_ID = /^\d{8}T\d{6}Z-[0-9a-f]{16}$/;
const DERIVED_ID = /^drv-[0-9a-f]{32}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A real instant in the one form `nowAt` writes, so times sort as strings. */
function isAt(value: unknown): value is string {
  if (typeof value !== "string" || !AT.test(value)) return false;
  const time = new Date(value);
  return !Number.isNaN(time.getTime()) && nowAt(time) === value;
}
const CLASS = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The current time, to the second, in Coordinated Universal Time. */
export function nowAt(date = new Date()): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/**
 * A fresh id: the time and 16 random hexadecimal digits, so ids sort by time
 * and two writers never pick the same one.
 */
export function newId(at = nowAt()): string {
  const compact = at.replaceAll("-", "").replaceAll(":", "");
  return `${compact.slice(0, 15)}Z-${randomBytes(8).toString("hex")}`;
}

/**
 * The time and id of a new decision about a finding, given its latest
 * decision. Decisions are ordered by time, then id, so one written in the
 * same second as the latest (or, with a clock behind, earlier) takes that
 * second and an id after the latest's, or the next second when no id in
 * that one sorts after it: the decision written last is the finding's latest.
 */
export function decisionStamp(
  latest: { at: string; id: string } | null,
  now = nowAt(),
): { at: string; id: string } {
  if (latest === null || now > latest.at) return { at: now, id: newId(now) };
  const ceiling = 0xffffffffffffffffn;
  const previous = TIME_ID.test(latest.id)
    ? BigInt(`0x${latest.id.slice(-16)}`)
    : 0n;
  // No id in the latest's second sorts after it: take the next second.
  if (previous === ceiling) {
    const next = nowAt(new Date(Date.parse(latest.at) + 1000));
    return { at: next, id: newId(next) };
  }
  const random = BigInt(`0x${randomBytes(4).toString("hex")}`);
  const next =
    previous + 1n + random > ceiling ? ceiling : previous + 1n + random;
  const prefix = newId(latest.at).slice(0, 17);
  return {
    at: latest.at,
    id: `${prefix}${next.toString(16).padStart(16, "0")}`,
  };
}

/**
 * The id of an event a script writes for a fact that can recur, derived from
 * that fact so re-running the script cannot record it twice. The fact must
 * name the repository and the change.
 */
export function derivedId(fact: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(fact))
    .digest("hex");
  return `drv-${digest.slice(0, 32)}`;
}

export function isId(value: unknown): value is string {
  return (
    typeof value === "string" && (TIME_ID.test(value) || DERIVED_ID.test(value))
  );
}

export function isClassName(value: unknown): value is string {
  return typeof value === "string" && CLASS.test(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function nullableText(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nullableCount(value: unknown): boolean {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) > 0)
  );
}

function optional(check: (value: unknown) => boolean) {
  return (value: unknown) => value === undefined || check(value);
}

function listOf(check: (value: unknown) => boolean) {
  return (value: unknown) => Array.isArray(value) && value.every(check);
}

function oneOf(allowed: readonly string[]) {
  return (value: unknown) => (allowed as readonly unknown[]).includes(value);
}

/** A field, the check its value must pass, and what to say when it fails. */
type Rule = [
  field: string,
  check: (value: unknown) => boolean,
  message: string,
];

/** Check an object's fields against `rules`; `where` names the object. */
function checkObject(
  value: unknown,
  where: string,
  rules: readonly Rule[],
  problems: string[],
): void {
  if (!isMapping(value)) {
    problems.push(`${where} must be an object`);
    return;
  }
  for (const [field, check, message] of rules)
    if (!check(value[field])) problems.push(`${where}.${field} ${message}`);
}

const HARNESS_RULES: Rule[] = ["name", "version", "entrypoint", "wrapper"].map(
  (field): Rule => [field, nullableText, "must be text or null"],
);

const SESSION_RULES: Rule[] = [
  ["jig_version", nullableText, "must be text or null"],
  ["skills", listOf(text), "must be a list of names"],
  ["model", nullableText, "must be text or null"],
  ["mode", nullableText, "must be text or null"],
  [
    "stated",
    listOf((field) => typeof field === "string"),
    "must be a list of field names",
  ],
];

function checkSession(value: unknown, problems: string[]): void {
  checkObject(value, "session", SESSION_RULES, problems);
  if (isMapping(value) && value.harness !== null)
    checkObject(value.harness, "session.harness", HARNESS_RULES, problems);
}

const CHANGE_RULES: Rule[] = [
  ["repository", text, "is required"],
  ["branch", nullableText, "must be text or null"],
  ["pull_request", nullableCount, "must be a positive whole number or null"],
  ["issue", nullableText, "must be text or null"],
];

const TARGET_RULES: Record<string, Rule[]> = {
  repository: [["name", text, "is required"]],
  tool: [
    ["tool", text, "is required for scope tool"],
    ["name", text, "is required"],
  ],
};

function checkTarget(value: unknown, problems: string[]): void {
  const rules = isMapping(value)
    ? TARGET_RULES[String(value.scope)]
    : undefined;
  if (isMapping(value) && rules === undefined)
    problems.push("target.scope must be repository or tool");
  else checkObject(value, "target", rules ?? [], problems);
}

/** Rules on the event itself, reported without a prefix. */
function checkTop(
  value: Record<string, unknown>,
  rules: readonly Rule[],
  problems: string[],
): void {
  for (const [field, check, message] of rules)
    if (!check(value[field])) problems.push(`${field} ${message}`);
}

const FINDING_RULES: Rule[] = [
  ["kind", oneOf(KINDS), `must be one of ${KINDS.join(", ")}`],
  ["severity", oneOf(SEVERITIES), `must be one of ${SEVERITIES.join(", ")}`],
  [
    "class",
    isClassName,
    "must be a kebab-case name such as narrow-fix-per-round",
  ],
  ["title", text, "is required"],
  ["description", text, "is required"],
  ["suggested_fix", text, "is required"],
  [
    "time_cost_minutes",
    optional(
      (minutes) =>
        typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0,
    ),
    "must be a number of minutes",
  ],
];

function checkFinding(
  value: Record<string, unknown>,
  problems: string[],
): void {
  checkObject(value.change, "change", CHANGE_RULES, problems);
  checkTop(value, FINDING_RULES.slice(0, 3), problems);
  checkTarget(value.target, problems);
  checkTop(value, FINDING_RULES.slice(3), problems);
}

const DECISION_RULES: Rule[] = [
  ["finding", isId, "must be a finding's id"],
  ["decision", oneOf(DECISIONS), `must be one of ${DECISIONS.join(", ")}`],
  ["reason", text, "is required"],
  ["commit", optional(text), "must be text"],
  ["pull_request", optional(nullableCount), "must be a positive whole number"],
  ["issue", optional(text), "must be text"],
];

function checkDecision(
  value: Record<string, unknown>,
  problems: string[],
): void {
  checkTop(value, DECISION_RULES, problems);
  if (value.decision === "escalated" && !text(value.issue))
    problems.push("an escalated decision names its issue");
}

/** What is wrong with `value` as an event; empty when it is a valid one. */
export function eventProblems(value: unknown): string[] {
  const problems: string[] = [];
  if (!isMapping(value)) return ["an event is a JSON object"];
  if (value.v !== EVENT_VERSION) problems.push(`v must be ${EVENT_VERSION}`);
  if (!isId(value.id)) problems.push("id is not a reflection event id");
  if (!isAt(value.at))
    problems.push("at must be a UTC time such as 2026-10-12T15:04:05Z");
  checkSession(value.session, problems);
  if (value.type === "finding") checkFinding(value, problems);
  else if (value.type === "decision") checkDecision(value, problems);
  else problems.push("type must be finding or decision");
  return problems;
}

/** Parse JSON that must be an object; throws naming `what` when it is not. */
export function parseObject(
  text: string,
  what = "the input",
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!isMapping(value)) throw new Error(`${what} is not a JSON object`);
  return value;
}

function isEvent(value: unknown): value is ReflectionEvent {
  return eventProblems(value).length === 0;
}

/** Parse one stored line; throws with every problem when it is not an event. */
export function parseEvent(line: string): ReflectionEvent {
  const value = parseObject(line, "the line");
  if (isEvent(value)) return value;
  throw new Error(eventProblems(value).join("; "));
}

/** The text an event is written as: one line of JSON. */
export function eventText(event: ReflectionEvent): string {
  return JSON.stringify(event);
}

/** Non-empty lines of a JSONL text. */
export function jsonlLines(input: string): string[] {
  return input
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
}

/**
 * Each id once: copies of one event collapse to one, and of different events
 * under one id, the copy whose stored text sorts first wins, whatever order
 * the copies arrived in.
 */
export function distinctById(events: readonly StoredEvent[]): StoredEvent[] {
  const byId = new Map<string, StoredEvent>();
  for (const stored of events) {
    const held = byId.get(stored.event.id);
    if (held === undefined || stored.text < held.text)
      byId.set(stored.event.id, stored);
  }
  return [...byId.values()];
}

/** Ids stored with more than one distinct text, with every distinct text. */
export function idConflicts<T extends { text: string; id: string }>(
  copies: readonly T[],
): Map<string, T[]> {
  const byId = new Map<string, Map<string, T>>();
  for (const copy of copies) {
    let texts = byId.get(copy.id);
    if (texts === undefined) {
      texts = new Map();
      byId.set(copy.id, texts);
    }
    if (!texts.has(copy.text)) texts.set(copy.text, copy);
  }
  const conflicts = new Map<string, T[]>();
  for (const [id, texts] of byId)
    if (texts.size > 1)
      conflicts.set(
        id,
        [...texts.values()].sort((a, b) => (a.text < b.text ? -1 : 1)),
      );
  return conflicts;
}

// ── Computed state ─────────────────────────────────────────────────────────

/** Where a fix for a finding would be made: a repository, or a tool. */
export function ownerOf(finding: FindingEvent): string {
  return finding.target.scope === "tool"
    ? `tool:${finding.target.tool}`
    : `repository:${finding.change.repository}`;
}

export function targetLabel(target: Target): string {
  return target.scope === "tool"
    ? `${target.tool}/${target.name}`
    : target.name;
}

function laterDecision(a: DecisionEvent, b: DecisionEvent): boolean {
  if (a.at !== b.at) return a.at > b.at;
  return a.id > b.id;
}

export interface FindingState {
  finding: FindingEvent;
  owner: string;
  status: Status;
  /** The latest decision, when there is one. */
  latest: DecisionEvent | null;
  decisions: DecisionEvent[];
}

export interface ComputedState {
  findings: Map<string, FindingState>;
  /** Decisions about a finding the events do not hold. */
  orphanDecisions: DecisionEvent[];
}

/** Compute every finding's status from a set of distinct events. */
export function computeState(
  events: readonly ReflectionEvent[],
): ComputedState {
  const findings = new Map<string, FindingState>();
  for (const event of events)
    if (event.type === "finding")
      findings.set(event.id, {
        finding: event,
        owner: ownerOf(event),
        status: "open",
        latest: null,
        decisions: [],
      });
  const orphanDecisions: DecisionEvent[] = [];
  for (const event of events) {
    if (event.type !== "decision") continue;
    const state = findings.get(event.finding);
    if (state === undefined) {
      orphanDecisions.push(event);
      continue;
    }
    state.decisions.push(event);
    if (state.latest === null || laterDecision(event, state.latest))
      state.latest = event;
  }
  for (const state of findings.values()) {
    state.decisions.sort((a, b) => (laterDecision(a, b) ? 1 : -1));
    if (state.latest !== null) state.status = state.latest.decision;
  }
  return { findings, orphanDecisions };
}

/** Open: no decision yet, or approved but not yet merged. */
export function isOpen(status: Status): boolean {
  return status === "open" || status === "approved";
}

/** A class recurs while its findings are open or deferred. */
export function countsTowardRecurrence(status: Status): boolean {
  return status === "open" || status === "deferred";
}

/** The recurrence count of one owner's class. */
export function recurrence(
  state: ComputedState,
  owner: string,
  className: string,
): number {
  let count = 0;
  for (const finding of state.findings.values())
    if (
      finding.owner === owner &&
      finding.finding.class === className &&
      countsTowardRecurrence(finding.status)
    )
      count++;
  return count;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function highestSeverity(
  severities: readonly Severity[],
): Severity | null {
  let best: Severity | null = null;
  for (const severity of severities)
    if (best === null || SEVERITY_RANK[severity] > SEVERITY_RANK[best])
      best = severity;
  return best;
}

/** The classes in use, with how many findings each has and one example. */
export function classesInUse(
  state: ComputedState,
): Array<{ class: string; findings: number; example: string }> {
  const classes = new Map<
    string,
    { findings: number; example: string; at: string }
  >();
  for (const { finding } of state.findings.values()) {
    const held = classes.get(finding.class);
    if (held === undefined)
      classes.set(finding.class, {
        findings: 1,
        example: finding.title,
        at: finding.at,
      });
    else {
      held.findings++;
      if (finding.at > held.at) {
        held.example = finding.title;
        held.at = finding.at;
      }
    }
  }
  return [...classes.entries()]
    .map(([name, held]) => ({
      class: name,
      findings: held.findings,
      example: held.example,
    }))
    .sort((a, b) => b.findings - a.findings || (a.class < b.class ? -1 : 1));
}

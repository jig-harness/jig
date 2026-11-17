/**
 * The priorities record, `priorities/v1`
 * ([design](../../../design/priorities-and-overview.md#one-priorities-record-each-level-whole)):
 * one level's objectives, in one versioned format. A repository's record is
 * `.config/priorities.yaml`, read from its default branch by the owner host's
 * dispatcher. The validator rejects unknown fields, duplicate ids, empty
 * selectors, negative values, shares above one and a share total above one
 * within one lane at a level, and names every problem; it never renormalizes
 * a person's choices. The site level is the hub's and is never required by a
 * host.
 */
import { load } from "../yaml.ts";
import { isRecord } from "../guards.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import { OBJECTIVE_CLASSES, type ObjectiveClass } from "./lanes.ts";

const PRIORITIES_FORMAT = "priorities/v1";
export const PRIORITIES_FILE = ".config/priorities.yaml";
const LEVELS = ["site", "repository", "individual"] as const;
export type Level = (typeof LEVELS)[number];

/** Tracker epics an objective selects: a tracker scope, and the epic keys or labels in it. */
export interface EpicSelector {
  scope: string;
  keys?: string[];
  labels?: string[];
}

/** An objective at another level, by its level, scope and id. */
export interface ObjectiveRef {
  level: Level;
  scope: string;
  id: string;
}

export interface Objective {
  id: string;
  class: ObjectiveClass;
  purpose: string;
  endState: string;
  owner: string;
  /** Exactly one of `epics` and `refs`. */
  epics?: EpicSelector[];
  refs?: ObjectiveRef[];
  /** A fraction of its lane's starts at this level; absent means an equal part of the lane's residual. */
  share?: number;
}

export interface PrioritiesRecord {
  level: Level;
  scope: string;
  revision: number;
  objectives: Objective[];
}

const ENVELOPE = ["format", "level", "scope", "revision", "objectives"];
const OBJECTIVE = [
  "id",
  "class",
  "purpose",
  "endState",
  "owner",
  "epics",
  "refs",
  "share",
];
const SELECTOR = ["scope", "keys", "labels"];
const REF = ["level", "scope", "id"];

/** Parse and validate a record's YAML text; `where` names it in problems. */
export function parsePrioritiesRecord(
  text: string,
  where = PRIORITIES_FILE,
): Outcome<PrioritiesRecord, "unreadable" | "invalid"> {
  let values: unknown;
  try {
    values = load(text);
  } catch (error) {
    return failed(
      "unreadable",
      `${where} is not YAML: ${(error as Error).message.split("\n")[0]}`,
    );
  }
  const problems = validatePrioritiesRecord(values);
  if (problems.length > 0)
    return failed("invalid", `${where}: ${problems.join("; ")}`);
  return ok(values as PrioritiesRecord);
}

/** Every problem with `value` as a `priorities/v1` record; empty when it is one. */
export function validatePrioritiesRecord(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["the record is not a mapping"];
  unknownFields(value, ENVELOPE, "the record", problems);
  if (value.format !== undefined && value.format !== PRIORITIES_FORMAT)
    problems.push(
      `format is ${JSON.stringify(value.format)}, not ${PRIORITIES_FORMAT}`,
    );
  if (!(LEVELS as readonly unknown[]).includes(value.level))
    problems.push(`level must be one of ${LEVELS.join(", ")}`);
  text(value.scope, "scope", problems);
  if (
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 1
  )
    problems.push("revision must be a whole number of at least 1");
  if (!Array.isArray(value.objectives)) {
    problems.push("objectives must be a list");
    return problems;
  }
  const ids = new Set<string>();
  const shareByLane = new Map<string, number>();
  value.objectives.forEach((raw, index) => {
    const where = `objectives[${index}]`;
    if (!isRecord(raw)) {
      problems.push(`${where} is not a mapping`);
      return;
    }
    objectiveProblems(raw, where, ids, shareByLane, problems);
  });
  for (const [lane, total] of shareByLane)
    if (total > 1 + 1e-9)
      problems.push(
        `the ${lane} objectives' shares total ${round(total)}, above one`,
      );
  return problems;
}

function objectiveProblems(
  raw: Record<string, unknown>,
  where: string,
  ids: Set<string>,
  shareByLane: Map<string, number>,
  problems: string[],
): void {
  unknownFields(raw, OBJECTIVE, where, problems);
  if (text(raw.id, `${where}.id`, problems)) {
    if (ids.has(raw.id as string))
      problems.push(`${where}.id ${JSON.stringify(raw.id)} is a duplicate`);
    ids.add(raw.id as string);
  }
  if (!(OBJECTIVE_CLASSES as readonly unknown[]).includes(raw.class))
    problems.push(
      `${where}.class must be one of ${OBJECTIVE_CLASSES.join(", ")}`,
    );
  for (const field of ["purpose", "endState", "owner"])
    text(raw[field], `${where}.${field}`, problems);
  const hasEpics = raw.epics !== undefined;
  const hasRefs = raw.refs !== undefined;
  if (hasEpics === hasRefs)
    problems.push(`${where} must have exactly one of epics and refs`);
  if (hasEpics) selectors(raw.epics, `${where}.epics`, problems);
  if (hasRefs) refs(raw.refs, `${where}.refs`, problems);
  if (raw.share === undefined) return;
  const bad = shareProblem(raw.share);
  if (bad !== null) problems.push(`${where}.share ${bad}`);
  else if (typeof raw.class === "string")
    shareByLane.set(
      raw.class,
      (shareByLane.get(raw.class) ?? 0) + (raw.share as number),
    );
}

function shareProblem(share: unknown): string | null {
  if (typeof share !== "number" || !Number.isFinite(share))
    return "must be a number";
  if (share < 0) return "is negative";
  return share > 1 ? "is above one" : null;
}

/** A reference that does not resolve: a cycle, or a target no record read holds. */
export interface ReferenceProblem {
  kind: "cycle" | "missing";
  /** The objective whose reference it is. */
  from: ObjectiveRef;
  /** The objective it references. */
  target: ObjectiveRef;
  /** The problem as a person reads it. */
  text: string;
}

/**
 * Whether a set of records, one per level, can be used for allocation: each
 * reference names an objective of a record in the set, with no cycle. Every
 * problem is named; a non-empty list makes the set infeasible.
 */
export function referenceProblems(
  records: readonly PrioritiesRecord[],
): ReferenceProblem[] {
  const problems = new Map<string, ReferenceProblem>();
  const byRef = new Map<string, Objective>();
  for (const r of records)
    for (const o of r.objectives) byRef.set(refKey(r.level, r.scope, o.id), o);
  for (const r of records)
    for (const o of r.objectives) {
      const from = { level: r.level, scope: r.scope, id: o.id };
      const seen = new Set<string>([refKey(r.level, r.scope, o.id)]);
      const add = (problem: ReferenceProblem): void => {
        if (!problems.has(problem.text)) problems.set(problem.text, problem);
      };
      const walk = (refs: ObjectiveRef[] | undefined): void => {
        for (const ref of refs ?? []) {
          const key = refKey(ref.level, ref.scope, ref.id);
          const target = { level: ref.level, scope: ref.scope, id: ref.id };
          if (seen.has(key)) {
            add({
              kind: "cycle",
              from,
              target,
              text: `${r.level} objective ${o.id} references a cycle through ${key}`,
            });
            continue;
          }
          const objective = byRef.get(key);
          if (objective === undefined) {
            add({
              kind: "missing",
              from,
              target,
              text: `${r.level} objective ${o.id} references ${key}, which no record read holds`,
            });
            continue;
          }
          seen.add(key);
          walk(objective.refs);
          seen.delete(key);
        }
      };
      walk(o.refs);
    }
  return [...problems.values()];
}

/**
 * Whether a reference problem is `record`'s own: a cycle, or a reference to
 * an objective of its own level and scope. A reference to another level or
 * scope resolves only where that record is read with it (the site's on the
 * hub), so a reader of one record reports it and never requires it.
 */
export function isOwnReferenceProblem(
  problem: ReferenceProblem,
  record: Pick<PrioritiesRecord, "level" | "scope">,
): boolean {
  return (
    problem.kind === "cycle" ||
    (problem.target.level === record.level &&
      problem.target.scope === record.scope)
  );
}

/** The tracker selectors an objective resolves to, through its references. */
export function resolvedSelectors(
  objective: Objective,
  records: readonly PrioritiesRecord[],
  seen = new Set<string>(),
): EpicSelector[] {
  if (objective.epics !== undefined) return objective.epics;
  const out: EpicSelector[] = [];
  for (const ref of objective.refs ?? []) {
    const key = refKey(ref.level, ref.scope, ref.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = records.find(
      (r) => r.level === ref.level && r.scope === ref.scope,
    );
    const target = record?.objectives.find((o) => o.id === ref.id);
    if (target !== undefined)
      out.push(...resolvedSelectors(target, records, seen));
  }
  return out;
}

export function refKey(level: string, scope: string, id: string): string {
  return `${level}:${scope}:${id}`;
}

/** Each mapping of a non-empty list, with the path to it; anything else is a problem. */
function eachMapping(
  value: unknown,
  where: string,
  problems: string[],
  visit: (raw: Record<string, unknown>, at: string) => void,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where} must be a non-empty list`);
    return;
  }
  value.forEach((raw, i) => {
    const at = `${where}[${i}]`;
    if (!isRecord(raw)) problems.push(`${at} is not a mapping`);
    else visit(raw, at);
  });
}

function selectors(value: unknown, where: string, problems: string[]): void {
  eachMapping(value, where, problems, (raw, at) => {
    unknownFields(raw, SELECTOR, at, problems);
    text(raw.scope, `${at}.scope`, problems);
    const keys = strings(raw.keys, `${at}.keys`, problems);
    const labels = strings(raw.labels, `${at}.labels`, problems);
    if (keys + labels === 0)
      problems.push(`${at} selects nothing: give keys or labels`);
  });
}

function refs(value: unknown, where: string, problems: string[]): void {
  eachMapping(value, where, problems, (raw, at) => {
    unknownFields(raw, REF, at, problems);
    if (!(LEVELS as readonly unknown[]).includes(raw.level))
      problems.push(`${at}.level must be one of ${LEVELS.join(", ")}`);
    text(raw.scope, `${at}.scope`, problems);
    text(raw.id, `${at}.id`, problems);
  });
}

/** The count of non-empty strings in an optional list, naming a malformed one. */
function strings(value: unknown, where: string, problems: string[]): number {
  if (value === undefined) return 0;
  if (!Array.isArray(value)) {
    problems.push(`${where} must be a list`);
    return 0;
  }
  if (value.length === 0) problems.push(`${where} is empty`);
  for (const v of value)
    if (typeof v !== "string" || v.trim() === "")
      problems.push(
        `${where} holds ${JSON.stringify(v)}, not a non-empty string`,
      );
  return value.length;
}

function text(value: unknown, where: string, problems: string[]): boolean {
  if (typeof value === "string" && value.trim() !== "") return true;
  problems.push(`${where} must be a non-empty string`);
  return false;
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      problems.push(`${where} has an unknown field \`${key}\``);
}

function round(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

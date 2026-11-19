import { createHash } from "node:crypto";
import { epicChildCensus } from "../../../../shared/epic-closure.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { JigError } from "../../../../shared/outcome.ts";
import { shapeOfKey } from "./tracker/keys.ts";
import type { Issue, IssueSummary } from "./tracker/port.ts";
import {
  DEFAULT_VOCABULARY,
  epicChildDisposition,
  type ReconcileVocabulary,
} from "../reconcile_parent_status.ts";
import {
  HEADING,
  headingKey,
  markdownLines,
} from "../../../../shared/spec/markdown.ts";

export class EpicSweepError extends JigError<"invalid-epic-sweep"> {
  constructor(reason: string) {
    super("invalid-epic-sweep", reason);
  }
}

interface Entry {
  path: string;
  heading: string;
}

interface Remainder {
  title: string;
  issue?: string;
}

export interface ScopeAssessment {
  epic: string;
  plan: Entry | null;
  roadmap: Entry | null;
  remainder: Remainder[];
}

type Outcome =
  | "close"
  | "close-with-remainder"
  | "keep-open"
  | "needs-assessment"
  | "needs-operator-checklist";

interface SweepRow {
  epic: string;
  title: string;
  url: string | null;
  plan: Entry | null;
  roadmap: Entry | null;
  planPresent: boolean;
  roadmapPresent: boolean;
  remainder: string[];
  finishedButOpen: boolean;
  completed: string[];
  abandoned: string[];
  personTails: string[];
  ordinaryTails: string[];
  open: string[];
  nextChild: string | null;
  operatorSteps: string[];
  outcome: Outcome;
}

interface Proposal {
  schema: "epic-sweep/v1";
  rows: SweepRow[];
  marker: string;
}

function isKey(value: unknown): value is string {
  return typeof value === "string" && shapeOfKey(value.toUpperCase()) !== null;
}

function isLine(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() !== "" && !/[\r\n]/.test(value)
  );
}

function parseEntry(value: unknown, field: string): Entry | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path.endsWith(".md") ||
    value.path
      .split("/")
      .some(
        (part) => !/^[\w.-]+$/.test(part) || part === ".." || part === ".",
      ) ||
    !isLine(value.heading)
  ) {
    throw new EpicSweepError(
      `${field} must give a repository-relative Markdown path and heading, or null`,
    );
  }
  return { path: value.path, heading: value.heading.trim() };
}

export function readScopes(raw: unknown): Map<string, ScopeAssessment> {
  if (!isRecord(raw) || !Array.isArray(raw.scopes)) {
    throw new EpicSweepError("Input must contain a scopes array");
  }
  const scopes = new Map<string, ScopeAssessment>();
  for (const value of raw.scopes) {
    if (
      !isRecord(value) ||
      !isKey(value.epic) ||
      !Array.isArray(value.remainder)
    ) {
      throw new EpicSweepError(
        "Each scope must specify an epic key and a remainder array",
      );
    }
    const epic = value.epic.toUpperCase();
    if (scopes.has(epic))
      throw new EpicSweepError(`Duplicate assessment for ${epic}`);
    const remainder = value.remainder.map((item: unknown): Remainder => {
      if (
        !isRecord(item) ||
        !isLine(item.title) ||
        (item.issue !== undefined && !isKey(item.issue))
      ) {
        throw new EpicSweepError(
          `${epic} remainder entries need a title and optional issue key`,
        );
      }
      return {
        title: item.title.trim(),
        ...(typeof item.issue === "string"
          ? { issue: item.issue.toUpperCase() }
          : {}),
      };
    });
    if (
      new Set(remainder.map(({ title }) => title)).size !== remainder.length
    ) {
      throw new EpicSweepError(`${epic} remainder titles must be distinct`);
    }
    scopes.set(epic, {
      epic,
      plan: parseEntry(value.plan, `${epic} plan`),
      roadmap: parseEntry(value.roadmap, `${epic} roadmap`),
      remainder,
    });
  }
  return scopes;
}

export type ReadEntry = (entry: Entry) => Promise<boolean>;

export function containsEntry(document: string, heading: string): boolean {
  const key = headingKey(heading);
  const itemNumber = /^\d+\.(?=\s)/.exec(key)?.[0];
  for (const line of markdownLines(document)) {
    if (line.kind !== "heading" || line.quoted || line.inItem) continue;
    const text = headingKey(
      (HEADING.exec(line.line)?.[2] ?? "").replace(/\s+#+\s*$/, ""),
    );
    if (text === key || (itemNumber && text.startsWith(`${itemNumber} `)))
      return true;
  }
  return false;
}

function operatorSteps(
  epic: Issue,
  vocabulary: ReconcileVocabulary,
): string[] | null {
  const owesOperatorCheck =
    epic.labels.includes(vocabulary.labels.manualOps) ||
    epicChildDisposition({ ...epic, labels: [] }, vocabulary) ===
      "person-check";
  if (!owesOperatorCheck) return [];
  const steps: string[] = [];
  let checklistDepth = 0;
  let found = false;
  for (const line of markdownLines(epic.description)) {
    if (line.quoted || line.inItem) continue;
    if (line.kind === "heading") {
      const match = HEADING.exec(line.line);
      const depth = match?.[1]?.length ?? 0;
      if (headingKey(match?.[2] ?? "") === "operator checklist") {
        checklistDepth = depth;
        found = true;
      } else if (depth <= checklistDepth) {
        checklistDepth = 0;
      }
    } else if (checklistDepth && line.kind === "text") {
      const step = /^\s*[-*+] \[ \]\s+(.+)$/.exec(line.line)?.[1]?.trim();
      if (step) steps.push(step);
    }
  }
  return found ? steps : null;
}

export async function assessEpic(
  epic: Issue,
  children: IssueSummary[],
  scope: ScopeAssessment | undefined,
  readEntry: ReadEntry,
  vocabulary = DEFAULT_VOCABULARY,
): Promise<SweepRow> {
  const classified = children.map((child) => ({
    key: child.identifier,
    disposition: epicChildDisposition(child, vocabulary),
  }));
  const census = epicChildCensus(classified, ({ disposition }) => disposition);
  const open = census.open.filter(
    ({ disposition }) => disposition === "incomplete",
  );
  const tails = (kind: "person-check" | "extractable-tail") =>
    census.open
      .filter(({ disposition }) => disposition === kind)
      .map(({ key }) => key);
  const [planPresent, roadmapPresent] = await Promise.all([
    scope?.plan ? readEntry(scope.plan) : false,
    scope?.roadmap ? readEntry(scope.roadmap) : false,
  ]);
  const remainder = scope?.remainder.map(({ title }) => title) ?? [];
  const nextChild = open[0]?.key ?? null;
  const steps = operatorSteps(epic, vocabulary);
  let outcome: Outcome = remainder.length ? "close-with-remainder" : "close";
  if (nextChild) outcome = "keep-open";
  else if (scope === undefined) outcome = "needs-assessment";
  else if (steps === null) outcome = "needs-operator-checklist";
  return {
    epic: epic.identifier,
    title: epic.title,
    url: epic.url,
    plan: scope?.plan ?? null,
    roadmap: scope?.roadmap ?? null,
    planPresent,
    roadmapPresent,
    remainder,
    finishedButOpen: census.finishedButOpen,
    completed: census.completed.map(({ key }) => key),
    abandoned: census.abandoned.map(({ key }) => key),
    personTails: tails("person-check"),
    ordinaryTails: tails("extractable-tail"),
    open: open.map(({ key }) => key),
    nextChild,
    operatorSteps: steps ?? [],
    outcome,
  };
}

export function createProposal(rows: SweepRow[]): Proposal {
  const schema = "epic-sweep/v1";
  const hash = createHash("sha256")
    .update(JSON.stringify({ schema, rows }))
    .digest("hex");
  return { schema, rows, marker: `<!-- jig:epic-sweep ${hash} -->` };
}

export function sweepMarkerOnLastLine(body: string): string | undefined {
  const line = body.trimEnd().split("\n").at(-1)?.trim();
  return line?.startsWith("<!-- jig:epic-sweep ") ? line : undefined;
}

function isCandidate(row: SweepRow): boolean {
  return row.outcome === "close" || row.outcome === "close-with-remainder";
}

export function acceptedRows(
  raw: unknown,
  body: string,
  precedingBodies: string[],
): SweepRow[] {
  if (
    !isRecord(raw) ||
    raw.schema !== "epic-sweep/v1" ||
    !Array.isArray(raw.rows)
  ) {
    throw new EpicSweepError("Invalid sweep proposal");
  }
  // The digest authenticates the rows generated by propose and shown before
  // the reply. It covers both closure candidates and rows still held open.
  const proposal = createProposal(raw.rows);
  const postedMarker = precedingBodies
    .map(sweepMarkerOnLastLine)
    .findLast((line) => line !== undefined);
  if (raw.marker !== proposal.marker || postedMarker !== proposal.marker) {
    throw new EpicSweepError(
      "The reply does not follow this unmodified sweep proposal",
    );
  }
  const reply = body.trim();
  const exclusions = /^all except\s+(.+)$/i.exec(reply)?.[1];
  const candidates = proposal.rows.filter(isCandidate);
  if (reply.toLowerCase() === "accept all") return candidates;
  if (!exclusions)
    throw new EpicSweepError(
      'Reply must be "accept all" or "all except <keys>"',
    );
  const excluded = new Set(
    exclusions.split(/\s*,\s*|\s+/).map((key) => key.toUpperCase()),
  );
  if (
    [...excluded].some((key) => !candidates.some((row) => row.epic === key))
  ) {
    throw new EpicSweepError(
      "The reply excludes a key outside the closure candidates",
    );
  }
  return candidates.filter((row) => !excluded.has(row.epic));
}

export function verifyApprovedScope(approved: SweepRow, fresh: SweepRow): void {
  if (fresh.planPresent || fresh.roadmapPresent) {
    throw new EpicSweepError(
      `${fresh.epic} still has a plan or roadmap entry on the integration branch`,
    );
  }
  const scopeOf = (row: SweepRow) => [
    row.plan,
    row.roadmap,
    row.remainder,
    row.operatorSteps,
  ];
  const approvedChildren = new Set([
    ...approved.completed,
    ...approved.abandoned,
    ...approved.personTails,
    ...approved.ordinaryTails,
  ]);
  if (
    !isCandidate(fresh) ||
    JSON.stringify(scopeOf(approved)) !== JSON.stringify(scopeOf(fresh)) ||
    approved.completed.some((key) => !fresh.completed.includes(key)) ||
    approved.abandoned.some((key) => !fresh.abandoned.includes(key)) ||
    [...fresh.completed, ...fresh.abandoned].some(
      (key) => !approvedChildren.has(key),
    ) ||
    fresh.personTails.some((key) => !approved.personTails.includes(key)) ||
    fresh.ordinaryTails.some((key) => !approved.ordinaryTails.includes(key))
  ) {
    throw new EpicSweepError(
      `${fresh.epic} scope or children changed since the proposal; propose again`,
    );
  }
}

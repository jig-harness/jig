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

function withoutClosingHashes(value: string): string {
  const trimmed = value.trimEnd();
  let hashes = trimmed.length;
  while (hashes > 0 && trimmed[hashes - 1] === "#") hashes -= 1;
  if (
    hashes === trimmed.length ||
    hashes === 0 ||
    !/\s/.test(trimmed[hashes - 1] ?? "")
  )
    return trimmed;
  let end = hashes;
  while (end > 0 && /\s/.test(trimmed[end - 1] ?? "")) end -= 1;
  return trimmed.slice(0, end);
}

export function containsEntry(document: string, heading: string): boolean {
  const key = headingKey(heading);
  const itemNumber = /^\d+\.(?=\s)/.exec(key)?.[0];
  for (const line of markdownLines(document)) {
    if (line.kind !== "heading" || line.quoted || line.inItem) continue;
    const text = headingKey(
      withoutClosingHashes(HEADING.exec(line.line)?.[2] ?? ""),
    );
    if (text === key || (itemNumber && text.startsWith(`${itemNumber} `)))
      return true;
  }
  return false;
}

type MarkdownLine =
  ReturnType<typeof markdownLines> extends Iterable<infer L> ? L : never;

// The scanner's list metadata decides what a line is: `depth` marks a line
// that opens an item, `boundary` a block that ends the item above it. An
// unchecked item owns the lines after it until a boundary, a heading or
// another item; after a blank line only lines indented to its content
// column stay in it. Only paragraph text can be carried as one line; any
// other block inside the item refuses the checklist.
interface ChecklistScan {
  steps: string[];
  checklistDepth: number;
  found: boolean;
  open: boolean;
  column: number;
  afterBlank: boolean;
}

function scanHeading(scan: ChecklistScan, line: MarkdownLine) {
  scan.open = false;
  const match = HEADING.exec(line.line);
  const depth = match?.[1]?.length ?? 0;
  if (headingKey(match?.[2] ?? "") === "operator checklist") {
    scan.checklistDepth = depth;
    scan.found = true;
  } else if (depth <= scan.checklistDepth) {
    scan.checklistDepth = 0;
  }
}

/** A line that opens a list item; false when the checklist cannot carry it. */
function scanItem(scan: ChecklistScan, line: MarkdownLine): boolean {
  const step = uncheckedListItem(line.line);
  if ((line.depth ?? 0) > 0 && (scan.open || step)) return false;
  if (nestsOnItsOwnLine(line.line)) return false;
  if (step) scan.steps.push(step);
  scan.open = step !== undefined;
  scan.column = line.contentColumn ?? 0;
  return true;
}

/** Any other line; false when the checklist cannot carry it. */
function scanContinuation(
  scan: ChecklistScan,
  line: MarkdownLine,
  wasAfterBlank: boolean,
): boolean {
  const indent = line.line.length - line.line.trimStart().length;
  // A boundary indented to the item's content column is a block inside the
  // item, which the checklist cannot carry as one line.
  if (scan.open && line.boundary && indent >= scan.column) return false;
  if (!scan.open || line.boundary || (wasAfterBlank && indent < scan.column)) {
    scan.open = false;
    return true;
  }
  if (line.kind !== "text" || line.quoted || line.inItem) return false;
  scan.steps[scan.steps.length - 1] += ` ${line.line.trim()}`;
  return true;
}

/** One line of the description; false when the checklist cannot carry it. */
function scanLine(scan: ChecklistScan, line: MarkdownLine): boolean {
  if (line.kind === "heading" && !line.quoted && !line.inItem) {
    scanHeading(scan, line);
    return true;
  }
  if (!scan.checklistDepth) return true;
  if (line.kind === "text" && !line.quoted && line.line.trim() === "") {
    scan.afterBlank = true;
    return true;
  }
  const wasAfterBlank = scan.afterBlank;
  scan.afterBlank = false;
  return line.depth !== undefined
    ? scanItem(scan, line)
    : scanContinuation(scan, line, wasAfterBlank);
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
  const scan: ChecklistScan = {
    steps: [],
    checklistDepth: 0,
    found: false,
    open: false,
    column: 0,
    afterBlank: false,
  };
  for (const line of markdownLines(epic.description)) {
    if (!scanLine(scan, line)) return null;
  }
  return scan.found ? scan.steps : null;
}

const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])(?:[ \t]|$)/;

/** Whether a list marker follows the first one on the same line (`- - [ ] x`). */
function nestsOnItsOwnLine(line: string): boolean {
  const text = line.trimStart();
  const marker = /^(?:[-*+]|\d+[.)])/.exec(text)?.[0];
  return marker !== undefined && LIST_MARKER.test(text.slice(marker.length));
}

/** Where the text after a list marker starts, or undefined when there is none. */
function afterListMarker(text: string): number | undefined {
  if ("-*+".includes(text[0] ?? "")) return 1;
  let cursor = 0;
  while (/[0-9]/.test(text[cursor] ?? "")) cursor += 1;
  return cursor > 0 && ".)".includes(text[cursor] ?? "")
    ? cursor + 1
    : undefined;
}

function skipBlanks(text: string, from: number): number {
  let cursor = from;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  return cursor;
}

function uncheckedListItem(line: string): string | undefined {
  const text = line.trimStart();
  const marker = afterListMarker(text);
  if (marker === undefined) return undefined;
  const box = skipBlanks(text, marker);
  if (!text.startsWith("[ ]", box)) return undefined;
  const after = box + 3;
  if (text[after] !== " " && text[after] !== "\t") return undefined;
  const step = text.slice(skipBlanks(text, after)).trim();
  return step === "" ? undefined : step;
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
  const prefix = "all except ";
  const exclusions = reply.toLowerCase().startsWith(prefix)
    ? reply.slice(prefix.length).trim()
    : undefined;
  const candidates = proposal.rows.filter(isCandidate);
  if (reply.toLowerCase() === "accept all") return candidates;
  if (!exclusions)
    throw new EpicSweepError(
      'Reply must be "accept all" or "all except <keys>"',
    );
  const excluded = new Set(
    exclusions.split(/[\s,]+/).map((key) => key.toUpperCase()),
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

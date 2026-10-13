/**
 * The team's decisions on an audit's recommendations, as the audit sheet's
 * copy button writes them, and what recording them does to the record:
 *
 *   # Jig audit decisions: example/web at 1a2b3c4 (2026-10-13)
 *   audit_feedback:
 *     v: 1
 *     repository: "example/web"
 *     commit: "<full sha>"
 *     report: "<fingerprint>"       # the report's recommendations (reportFingerprint)
 *     profile: team-standard        # optional: only when the reader changed it
 *     accept: [R1, R3]              # optional
 *     refine:                       # optional
 *       - { id: R2, note: "Use the existing lint job." }
 *     decline:                      # optional
 *       - { id: R4, refs: ["M5/<id>"], reason: "…", revisit_when: "…" }
 *     wrong:                        # optional
 *       - { id: R5, refs: ["M2/<id>"], note: "…" }
 *
 * A decline becomes an entry in the record's `declined:` list, or renews the
 * entry that already declines the same refs, and a profile choice sets
 * `profile:`. Accepted and refined recommendations become the
 * work, in adoption order. A wrong one is a calibration note: the audit
 * misjudged something, so the criterion's score is left for the agent to
 * re-examine and never changed here.
 *
 * The block is checked against the audit it was written for: the report's
 * repository and the fingerprint of its recommendations, the record's commit
 * (and, for a sheet, the commit of the record it was rendered with), the
 * report's recommendation ids and each one's refs. A block written for another audit changes nothing.
 */
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import type { Module, Score } from "./criteria.ts";
import { extractEmbedded } from "../../../decide/scripts/sheet-kit/html.ts";
import { DATA_BLOCK_ID, parseEmbedded } from "../report/data.ts";
import { LIGHTER_PREFIX } from "../report/feedback-text.ts";
import { byValue } from "../report/model.ts";
import {
  parseReportSource,
  type Recommendation as SourceRecommendation,
  reportFingerprint,
} from "../report/source.ts";
import type { Profiles } from "./profiles.ts";
import {
  type AuditRecord,
  checkProfile,
  checkRecord,
  DECLINED_REF,
  type Declined,
  heldCriteria,
  declinedEntryLines,
  parseRecord,
} from "./record.ts";

/** Feedback that cannot be recorded against this audit, with every reason. */
export class FeedbackRefused extends Error {
  readonly problems: string[];
  constructor(problems: string[], options?: ErrorOptions) {
    super(problems.join("; "), options);
    this.name = "FeedbackRefused";
    this.problems = problems;
  }
}

function refuse(problem: string): never {
  throw new FeedbackRefused([problem]);
}

export interface Feedback {
  repository: string;
  commit: string;
  /** The fingerprint of the report the decisions were made on. */
  report: string;
  /** Present only when the reader chose a profile. */
  profile?: string;
  accept: string[];
  refine: { id: string; note?: string }[];
  decline: {
    id: string;
    refs: string[];
    reason: string;
    revisit_when: string;
  }[];
  wrong: { id: string; refs: string[]; note?: string }[];
}

const START = /^(\s*)audit_feedback:\s*(#.*)?$/;

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

const isComment = (line: string): boolean => line.trimStart().startsWith("#");

/**
 * The `audit_feedback:` document within pasted text: its key's line and every
 * line indented under it. A leading sentence, a code fence or a trailing
 * remark around the block is left out.
 */
function feedbackDocument(source: string): string {
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((l, i) => (START.test(l) ? [i] : []));
  if (starts.length === 0) refuse("no audit_feedback: block in the input");
  if (starts.length > 1)
    refuse("more than one audit_feedback: block; give one at a time");
  const at = starts[0] ?? 0;
  const base = indentOf(lines[at] ?? "");
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const blank = line.trim() === "";
    if (!blank && !isComment(line) && indentOf(line) <= base) break;
    body.push(line.slice(Math.min(base, indentOf(line))));
  }
  return ["audit_feedback:", ...body].join("\n");
}

function strictMapping(
  raw: unknown,
  keys: readonly string[],
  at: string,
): Record<string, unknown> {
  if (!isMapping(raw)) refuse(`${at} must be a mapping`);
  const unknown = Object.keys(raw).filter((k) => !keys.includes(k));
  if (unknown.length > 0) refuse(`${at}: unknown key ${unknown.join(", ")}`);
  return raw;
}

function required(v: unknown, at: string): string {
  if (typeof v !== "string" || v.trim() === "") refuse(`${at} is required`);
  return v;
}

function idOf(v: unknown, at: string): string {
  if (typeof v !== "string" || !/^R\d+$/.test(v))
    refuse(`${at}: a recommendation id is R<n>`);
  return v;
}

/** An optional note: absent or empty means none. */
function noteOf(v: unknown, at: string): { note?: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "string") refuse(`${at} must be text`);
  return v.trim() === "" ? {} : { note: v };
}

function refsOf(v: unknown, at: string): string[] {
  if (!Array.isArray(v) || v.length === 0)
    refuse(`${at} must list the recommendation's refs`);
  return v.map((ref, i) => {
    if (typeof ref !== "string" || !DECLINED_REF.test(ref))
      refuse(`${at}[${i}]: a ref is M<n>/<id> or config/<finding>`);
    return ref;
  });
}

function listOf(v: unknown, at: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) refuse(`${at} must be a list`);
  return v;
}

function parseRefine(raw: unknown, at: string): Feedback["refine"][number] {
  const r = strictMapping(raw, ["id", "note"], at);
  return { id: idOf(r.id, `${at}.id`), ...noteOf(r.note, `${at}.note`) };
}

function parseDecline(raw: unknown, at: string): Feedback["decline"][number] {
  const d = strictMapping(raw, ["id", "refs", "reason", "revisit_when"], at);
  return {
    id: idOf(d.id, `${at}.id`),
    refs: refsOf(d.refs, `${at}.refs`),
    reason: required(d.reason, `${at}.reason`),
    revisit_when: required(d.revisit_when, `${at}.revisit_when`),
  };
}

function parseWrong(raw: unknown, at: string): Feedback["wrong"][number] {
  const w = strictMapping(raw, ["id", "refs", "note"], at);
  return {
    id: idOf(w.id, `${at}.id`),
    refs: refsOf(w.refs, `${at}.refs`),
    ...noteOf(w.note, `${at}.note`),
  };
}

/** Every id the feedback decides, once per choice. */
function choiceIds(f: Feedback): string[] {
  return [
    ...f.accept,
    ...[...f.refine, ...f.decline, ...f.wrong].map((c) => c.id),
  ];
}

const TOP_KEYS = [
  "v",
  "repository",
  "commit",
  "report",
  "profile",
  "accept",
  "refine",
  "decline",
  "wrong",
];

/**
 * Parse a feedback block, tolerating text pasted around it. Throws
 * `FeedbackRefused` for a block that is not one: an unknown key, an id that
 * is not R<n> or appears in two choices, a decline without its refs, reason
 * or revisit condition.
 */
export function parseFeedback(source: string): Feedback {
  const document = feedbackDocument(source);
  let raw: unknown;
  try {
    raw = load(document);
  } catch (error) {
    throw new FeedbackRefused(
      [
        `the audit_feedback: block is not valid YAML: ${error instanceof Error ? error.message : error}`,
      ],
      { cause: error },
    );
  }
  const at = "audit_feedback";
  const f = strictMapping(isMapping(raw) ? raw[at] : raw, TOP_KEYS, at);
  if (f.v !== 1) refuse(`${at}.v must be 1`);
  const feedback: Feedback = {
    repository: required(f.repository, `${at}.repository`),
    commit: required(f.commit, `${at}.commit`),
    report: required(f.report, `${at}.report`),
    ...(f.profile === undefined
      ? {}
      : { profile: required(f.profile, `${at}.profile`) }),
    accept: listOf(f.accept, `${at}.accept`).map((id, i) =>
      idOf(id, `${at}.accept[${i}]`),
    ),
    refine: listOf(f.refine, `${at}.refine`).map((r, i) =>
      parseRefine(r, `${at}.refine[${i}]`),
    ),
    decline: listOf(f.decline, `${at}.decline`).map((d, i) =>
      parseDecline(d, `${at}.decline[${i}]`),
    ),
    wrong: listOf(f.wrong, `${at}.wrong`).map((w, i) =>
      parseWrong(w, `${at}.wrong[${i}]`),
    ),
  };
  const ids = choiceIds(feedback);
  const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (twice.length > 0)
    refuse(`${[...new Set(twice)].join(", ")}: one choice per recommendation`);
  return feedback;
}

/** A recommendation, as the report source states it. */
export type Recommendation = Pick<
  SourceRecommendation,
  "id" | "refs" | "title" | "action" | "leverage" | "effort" | "quick_win"
>;

/** What feedback is checked against in a report, and the drift it lists first. */
export interface ReportView {
  repository: string;
  /** The fingerprint of its recommendations (`reportFingerprint`). */
  fingerprint: string;
  /** The commit of the record a sheet was rendered with; a source names none. */
  recordCommit?: string;
  recommendations: Recommendation[];
  drift: { text: string; evidence: string[] }[];
}

/**
 * The report source a decision block was written for: the source JSON the
 * agent wrote, or the audit sheet itself, whose embedded data holds it.
 */
export function readReportView(text: string, file: string): ReportView {
  let raw: unknown;
  let recordCommit: unknown;
  try {
    if (/^\s*<!doctype html/i.test(text)) {
      const data = parseEmbedded(
        extractEmbedded(text, DATA_BLOCK_ID, "audit data").value,
      );
      raw = data.source;
      recordCommit = data.record.commit;
    } else raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: neither a report source nor an audit sheet`, {
      cause: error,
    });
  }
  const source = parseReportSource(raw);
  return {
    repository: source.repository.name,
    fingerprint: reportFingerprint(source.recommendations),
    ...(typeof recordCommit === "string" ? { recordCommit } : {}),
    recommendations: source.recommendations,
    drift: source.drift ?? [],
  };
}

export interface PlanContext {
  record: AuditRecord;
  report: ReportView;
  modules: readonly Module[];
  profiles: Profiles;
  /** The day the record's declines are judged on, YYYY-MM-DD. */
  today: string;
}

export interface WorkItem extends Recommendation {
  choice: "accept" | "refine";
  note?: string;
}

export interface CalibrationNote {
  id: string;
  title: string;
  note?: string;
  /** Each ref with what the record holds for it; a configuration finding has no score. */
  refs: {
    ref: string;
    statement: string | null;
    score: Score | null;
    evidence: string | null;
  }[];
}

export interface FeedbackPlan {
  repository: string;
  commit: string;
  /**
   * Declines to record. One with `replaces` renews the record's entry at that
   * index (the same refs, decided again with a new reason, condition or
   * date); the others are added.
   */
  declined: { id: string; entry: Declined; replaces?: number }[];
  /** Declines the record already holds exactly as written. */
  alreadyDeclined: string[];
  profile: { from: string | null; to: string } | null;
  /** Drift the report found: fixed first, before any module work. */
  drift: ReportView["drift"];
  /** Accepted and refined recommendations, in the order to take them. */
  work: WorkItem[];
  wrong: CalibrationNote[];
}

const sameRefs = (a: readonly string[], b: readonly string[]): boolean => {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((r) => set.has(r));
};

const sameDecline = (a: Declined, b: Declined): boolean =>
  a.reason === b.reason &&
  a.revisit_when === b.revisit_when &&
  a.revisit_after === b.revisit_after;

/** Why a decline or wrong does not match the recommendation it names. */
function refsProblems(
  feedback: Feedback,
  byId: ReadonlyMap<string, Recommendation>,
): string[] {
  return [...feedback.decline, ...feedback.wrong].flatMap((c) => {
    const rec = byId.get(c.id);
    if (!rec || sameRefs(c.refs, rec.refs)) return [];
    return [
      `${c.id}: refs ${c.refs.join(", ")} differ from the report's ${rec.refs.join(", ")}`,
    ];
  });
}

/** A decline naming a criterion this plugin version does not have. */
function staleDeclines(
  feedback: Feedback,
  modules: readonly Module[],
): string[] {
  const known = new Set(modules.flatMap((m) => m.criteria.map((c) => c.key)));
  return feedback.decline.flatMap((d) =>
    d.refs
      .filter((r) => !r.startsWith("config/") && !known.has(r))
      .map((r) => `${d.id}: ${r} is not a criterion of this plugin version`),
  );
}

/**
 * Accepted or refined work that names a criterion the record now holds: the
 * record can gain a decline after the sheet was rendered at the same commit.
 */
function heldWork(feedback: Feedback, ctx: PlanContext): string[] {
  const held = heldCriteria(ctx.record, ctx.modules, ctx.today);
  return [...feedback.accept, ...feedback.refine.map((r) => r.id)].flatMap(
    (id) =>
      (ctx.report.recommendations.find((r) => r.id === id)?.refs ?? [])
        .filter((ref) => held.has(ref))
        .map(
          (ref) =>
            `${id}: the record declines ${ref} and holds it until: ${held.get(ref)}; leave it out, or record the condition as met first`,
        ),
  );
}

/** Two declines that decide the same refs differently. */
function conflictingDeclines(feedback: Feedback): string[] {
  return feedback.decline.flatMap((d) => {
    const first = feedback.decline.find((e) => sameRefs(e.refs, d.refs));
    return first && first !== d && !sameDecline(first, d)
      ? [
          `${d.id}: declines ${d.refs.join(", ")} as ${first.id} does, with another reason or condition; decide them once`,
        ]
      : [];
  });
}

function refusals(
  feedback: Feedback,
  ctx: PlanContext,
  byId: ReadonlyMap<string, Recommendation>,
): string[] {
  const { record, report } = ctx;
  return [
    ...(feedback.repository === report.repository
      ? []
      : [
          `the block is for ${feedback.repository}; the report is for ${report.repository}`,
        ]),
    ...(feedback.commit === record.commit
      ? []
      : [
          `the block is for commit ${feedback.commit}; the record audited ${record.commit}`,
        ]),
    ...(feedback.report === report.fingerprint
      ? []
      : [
          `the block was made on another version of the report (${feedback.report}; this one is ${report.fingerprint}): render the sheet again and decide on it`,
        ]),
    ...(report.recordCommit === undefined ||
    report.recordCommit === record.commit
      ? []
      : [
          `the sheet was rendered with the record of commit ${report.recordCommit}; this record audited ${record.commit}`,
        ]),
    ...choiceIds(feedback)
      .filter((id) => !byId.has(id))
      .map((id) => `${id}: the report has no such recommendation`),
    ...refsProblems(feedback, byId),
    ...staleDeclines(feedback, ctx.modules),
    ...conflictingDeclines(feedback),
    ...heldWork(feedback, ctx),
    ...(feedback.profile === undefined
      ? []
      : checkProfile({ ...record, profile: feedback.profile }, ctx.profiles)),
  ];
}

/** Where a recommendation falls in adoption order; configuration-only ones first. */
function adoptionRank(
  refs: readonly string[],
  order: readonly string[],
): number {
  const first = refs.find((r) => !r.startsWith("config/"));
  if (first === undefined) return -1;
  const at = order.indexOf(first.split("/")[0] ?? "");
  return at < 0 ? order.length : at;
}

const idNumber = (id: string): number => Number(id.slice(1));

/**
 * Order work by the adoption order of its first module ref (configuration
 * fixes first: they are the cheapest), then higher leverage, then smaller
 * effort, then the report's own numbering.
 */
function byAdoption(order: readonly string[]) {
  return (a: WorkItem, b: WorkItem): number =>
    adoptionRank(a.refs, order) - adoptionRank(b.refs, order) ||
    byValue(a, b) ||
    idNumber(a.id) - idNumber(b.id);
}

function workOf(
  feedback: Feedback,
  byId: ReadonlyMap<string, Recommendation>,
  order: readonly string[],
): WorkItem[] {
  const chosen: { id: string; choice: WorkItem["choice"]; note?: string }[] = [
    ...feedback.accept.map((id) => ({ id, choice: "accept" as const })),
    ...feedback.refine.map((r) => ({ ...r, choice: "refine" as const })),
  ];
  return chosen
    .flatMap((c) => {
      const rec = byId.get(c.id);
      return rec ? [{ ...rec, ...c }] : [];
    })
    .sort(byAdoption(order));
}

function calibrationOf(
  feedback: Feedback,
  ctx: PlanContext,
  byId: ReadonlyMap<string, Recommendation>,
): CalibrationNote[] {
  const statements = new Map(
    ctx.modules.flatMap((m) => m.criteria.map((c) => [c.key, c.statement])),
  );
  return feedback.wrong.map((w) => ({
    id: w.id,
    title: byId.get(w.id)?.title ?? w.id,
    ...(w.note === undefined ? {} : { note: w.note }),
    refs: w.refs.map((ref) => {
      const entry = ctx.record.criteria.get(ref);
      return {
        ref,
        statement: statements.get(ref) ?? null,
        score: entry?.score ?? null,
        evidence: entry?.evidence ?? null,
      };
    }),
  }));
}

function declinesOf(
  feedback: Feedback,
  record: AuditRecord,
): Pick<FeedbackPlan, "declined" | "alreadyDeclined"> {
  const declined: FeedbackPlan["declined"] = [];
  const alreadyDeclined: string[] = [];
  const decided: Declined[] = [];
  for (const { id, ...entry } of feedback.decline) {
    // A second decision on the same refs agrees with the first: `refusals`
    // refuses a block where they differ.
    if (decided.some((d) => sameRefs(d.refs, entry.refs))) {
      alreadyDeclined.push(id);
      continue;
    }
    decided.push(entry);
    const at = record.declined.findIndex((d) => sameRefs(d.refs, entry.refs));
    const existing = record.declined[at];
    // Replaying a block records nothing twice; deciding the same refs again,
    // as when a revisit date has passed, renews the entry instead, keeping
    // the keys the decision does not set.
    if (!existing) declined.push({ id, entry });
    else if (sameDecline(existing, entry)) alreadyDeclined.push(id);
    else
      declined.push({
        id,
        entry: {
          ...entry,
          ...(existing.other ? { other: existing.other } : {}),
        },
        replaces: at,
      });
  }
  return { declined, alreadyDeclined };
}

/**
 * What recording `feedback` does: the declines to add, the profile change,
 * the ordered work and the calibration notes. Throws `FeedbackRefused` when
 * the block was not written for this audit, names a recommendation the
 * report does not have, or names refs or a profile that do not fit.
 */
export function planFeedback(
  feedback: Feedback,
  ctx: PlanContext,
): FeedbackPlan {
  const byId = new Map(ctx.report.recommendations.map((r) => [r.id, r]));
  const problems = refusals(feedback, ctx, byId);
  if (problems.length > 0) throw new FeedbackRefused(problems);
  const to = feedback.profile;
  return {
    repository: feedback.repository,
    commit: feedback.commit,
    ...declinesOf(feedback, ctx.record),
    profile:
      to === undefined || to === ctx.record.profile
        ? null
        : { from: ctx.record.profile ?? null, to },
    drift: ctx.report.drift,
    work: workOf(feedback, byId, ctx.profiles.order),
    wrong: calibrationOf(feedback, ctx, byId),
  };
}

/** Whether recording the plan changes the record. */
export function changesRecord(plan: FeedbackPlan): boolean {
  return plan.profile !== null || plan.declined.length > 0;
}

/** Where a YAML comment starts in `text`, outside quoted scalars, or -1. */
function commentAt(text: string): number {
  const tokens = /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|(?:^|\s)#/g;
  for (const m of text.matchAll(tokens))
    if (m[0].endsWith("#")) return m.index + m[0].length - 1;
  return -1;
}

/** A top-level `key: value  # comment` line's value, and its comment with the space before it. */
function splitLine(line: string, key: string): { value: string; tail: string } {
  const rest = line.slice(key.length + 1);
  const at = commentAt(rest);
  if (at < 0) return { value: rest.trim(), tail: "" };
  const before = rest.slice(0, at);
  const gap = before.slice(before.trimEnd().length) || " ";
  return { value: before.trim(), tail: `${gap}${rest.slice(at)}` };
}

/** The line of a top-level `key:`, or -1. */
function topLevel(lines: readonly string[], key: string): number {
  const pattern = new RegExp(`^${key}:(\\s|$)`);
  return lines.findIndex((l) => pattern.test(l));
}

function setProfile(lines: string[], id: string): void {
  const at = topLevel(lines, "profile");
  if (at >= 0) {
    lines[at] = `profile: ${id}${splitLine(lines[at] ?? "", "profile").tail}`;
    return;
  }
  const after = ["shape", "commit"]
    .map((k) => topLevel(lines, k))
    .find((i) => i >= 0);
  lines.splice((after ?? -1) + 1, 0, `profile: ${id}`);
}

/** The index after the last line of the block list that starts at `first`, with its dashes at `indent`. */
function blockEnd(
  lines: readonly string[],
  first: number,
  indent: number,
): number {
  let end = first + 1;
  for (let i = first + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || isComment(line)) continue;
    const inside =
      indentOf(line) > indent ||
      (indentOf(line) === indent && line.trimStart().startsWith("-"));
    if (!inside) break;
    end = i + 1;
  }
  return end;
}

/** The first line after `at` that is neither blank nor a comment, or -1. */
function nextContent(lines: readonly string[], at: number): number {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() !== "" && !isComment(line)) return i;
  }
  return -1;
}

/** The first line of each item of the block list that starts at `first`, and the list's end. */
function listItems(
  lines: readonly string[],
  first: number,
  indent: number,
): { starts: number[]; end: number } {
  const end = blockEnd(lines, first, indent);
  const starts: number[] = [];
  for (let i = first; i < end; i++) {
    const line = lines[i] ?? "";
    if (indentOf(line) === indent && line.trimStart().startsWith("-"))
      starts.push(i);
  }
  return { starts, end };
}

/**
 * Write `entry` over item `index` of the block list, keeping the comments
 * the item carried: a comment at the end of a replaced line moves onto a
 * line of its own above the entry.
 */
function replaceItem(
  lines: string[],
  items: { starts: number[]; end: number },
  index: number,
  entry: Declined,
  indent: number,
): void {
  const start = items.starts[index];
  if (start === undefined)
    throw new Error(`declined: has no entry ${index + 1} to renew`);
  const end = items.starts[index + 1] ?? items.end;
  const comments = lines.slice(start, end).flatMap((line) => {
    if (isComment(line)) return [line];
    const at = commentAt(line);
    return at < 0 ? [] : [`${" ".repeat(indent)}${line.slice(at)}`];
  });
  lines.splice(
    start,
    end - start,
    ...comments,
    ...declinedEntryLines(entry, " ".repeat(indent)),
  );
}

/**
 * Renew the `replacing` entries and add `entries` to the `declined:` list at
 * line `at`, in whichever form the list is written.
 */
function extendDeclined(
  lines: string[],
  at: number,
  entries: readonly Declined[],
  replacing: ReadonlyMap<number, Declined>,
  existing: readonly Declined[],
): void {
  const { value, tail } = splitLine(lines[at] ?? "", "declined");
  const render = (list: readonly Declined[], indent = "  ") =>
    list.flatMap((d) => declinedEntryLines(d, indent));
  if (value === "") {
    const first = nextContent(lines, at);
    const item = first >= 0 && /^\s*-(\s|$)/.test(lines[first] ?? "");
    if (!item) {
      lines.splice(at + 1, 0, ...render(entries));
      return;
    }
    const indent = indentOf(lines[first] ?? "");
    lines.splice(
      blockEnd(lines, first, indent),
      0,
      ...render(entries, " ".repeat(indent)),
    );
    // Later items first, so the earlier ones keep their lines.
    for (const index of [...replacing.keys()].sort((a, b) => b - a))
      replaceItem(
        lines,
        listItems(lines, first, indent),
        index,
        replacing.get(index) as Declined,
        indent,
      );
    return;
  }
  if (!["[]", "null", "~"].includes(value) && !/^\[.*\]$/.test(value))
    throw new Error(
      "declined: is written in a form this cannot extend; write it as a block list (- refs: …)",
    );
  // A one-line list holds no comments of its own, so it is rewritten whole:
  // each existing entry as it was read, every key it has, then the new ones.
  const kept = render(existing.map((d, i) => replacing.get(i) ?? d));
  lines.splice(at, 1, `declined:${tail}`, ...kept, ...render(entries));
}

/**
 * The record's text with the plan's declines added to `declined:` and its
 * profile set. The text is edited line by line rather than re-serialised, so
 * every comment in the record is kept.
 */
export function editRecordText(source: string, plan: FeedbackPlan): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (plan.profile) setProfile(lines, plan.profile.to);
  const entries = plan.declined
    .filter((d) => d.replaces === undefined)
    .map((d) => d.entry);
  const replacing = new Map(
    plan.declined.flatMap((d) =>
      d.replaces === undefined ? [] : [[d.replaces, d.entry] as const],
    ),
  );
  const at = topLevel(lines, "declined");
  if (plan.declined.length === 0) return lines.join(eol);
  if (at >= 0)
    extendDeclined(
      lines,
      at,
      entries,
      replacing,
      parseRecord(source, "record").declined,
    );
  else {
    // A record without the key gains it after its last line.
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
    lines.splice(
      end,
      0,
      "declined:",
      ...entries.flatMap((d) => declinedEntryLines(d)),
    );
  }
  return lines.join(eol);
}

/**
 * What is wrong with an edited record: it does not parse, it has a problem
 * `checkRecord` finds that the original did not, or it does not hold what the
 * plan recorded.
 */
export function checkEdited(
  before: AuditRecord,
  edited: string,
  file: string,
  plan: FeedbackPlan,
  catalog: { modules: Module[]; profiles: Profiles },
): string[] {
  let after: AuditRecord;
  try {
    after = parseRecord(edited, file);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  const known = new Set(checkRecord(before, catalog.modules, catalog.profiles));
  const problems = checkRecord(after, catalog.modules, catalog.profiles).filter(
    (p) => !known.has(p),
  );
  if (plan.profile && after.profile !== plan.profile.to)
    problems.push(
      `profile: reads ${after.profile ?? "nothing"}, not ${plan.profile.to}`,
    );
  const added = plan.declined.filter((d) => d.replaces === undefined).length;
  if (after.declined.length !== before.declined.length + added)
    problems.push(
      `declined: holds ${after.declined.length} entries, not ${before.declined.length + added}`,
    );
  const renewed = new Map(
    plan.declined.flatMap((d) =>
      d.replaces === undefined ? [] : [[d.replaces, d] as const],
    ),
  );
  // Every entry reads as the plan left it: renewed ones as their new
  // decision, every other one as it was, each with every key it had.
  before.declined.forEach((was, i) => {
    const d = renewed.get(i);
    const want = d ? d.entry : was;
    const now = after.declined[i];
    if (
      !now ||
      !sameRefs(now.refs, want.refs) ||
      !sameDecline(now, want) ||
      // Kept values are JSON values (`parseDeclined`), so their JSON text
      // compares them exactly.
      JSON.stringify(now.other ?? {}) !== JSON.stringify(want.other ?? {})
    )
      problems.push(
        d
          ? `declined: entry ${i + 1} does not read as the renewed decline of ${d.id}`
          : `declined: entry ${i + 1} no longer reads as it did`,
      );
  });
  return problems;
}

const refList = (refs: readonly string[]): string => `[${refs.join(", ")}]`;

function recordedLines(
  plan: FeedbackPlan,
  record: string,
  dryRun: boolean,
): string[] {
  const changes = [
    ...plan.declined.map(
      (d) =>
        `- ${d.replaces === undefined ? "declined" : "declined again"} ${d.id} ${refList(d.entry.refs)}: ${d.entry.reason} (revisit when ${d.entry.revisit_when})`,
    ),
    ...(plan.profile
      ? [
          `- profile: ${plan.profile.to} (was ${plan.profile.from ?? "not set"})`,
        ]
      : []),
  ];
  const held = plan.alreadyDeclined.map(
    (id) => `- ${id}: already declined as written; not added again`,
  );
  if (changes.length === 0)
    return [`Nothing new to record in ${record}.`, ...held];
  return [
    dryRun
      ? `Would record in ${record} (dry run: nothing written):`
      : `Recorded in ${record}:`,
    ...changes,
    ...held,
  ];
}

function driftLines(drift: FeedbackPlan["drift"]): string[] {
  if (drift.length === 0) return [];
  return [
    "",
    "Drift first: where what the repository says and does disagree (cheap to fix, and it misleads every session until it is):",
    ...drift.map((d) => `- ${d.text} (${d.evidence.join(", ")})`),
  ];
}

/** A work item's line: the lighter option, when the team chose it, is the work. */
function workText(w: WorkItem): string {
  if (w.note?.startsWith(LIGHTER_PREFIX)) {
    const [lighter, ...rest] = w.note.slice(LIGHTER_PREFIX.length).split("; ");
    const extra = rest.length > 0 ? ` (note: ${rest.join("; ")})` : "";
    return `${w.title} — the lighter option: ${lighter}${extra} (the full action, not chosen: ${w.action})`;
  }
  return `${w.title} — ${w.action}${w.note ? ` (note: ${w.note})` : ""}`;
}

function workLines(work: readonly WorkItem[]): string[] {
  if (work.length === 0) return [];
  return [
    "",
    "Work, in adoption order (each ready for /jig:audit apply <ref> or for filing):",
    ...work.map(
      (w, i) => `${i + 1}. ${w.id} ${refList(w.refs)} ${workText(w)}`,
    ),
  ];
}

function calibrationLines(wrong: readonly CalibrationNote[]): string[] {
  if (wrong.length === 0) return [];
  return [
    "",
    "This finding is wrong (calibration notes: re-examine; the score is not changed):",
    ...wrong.flatMap((w) => [
      `- ${w.id} ${w.title}`,
      ...w.refs.map((r) =>
        r.ref.startsWith("config/")
          ? `  ${r.ref}: a configuration finding; config-fit.ts decides it`
          : `  ${r.ref}${r.statement ? ` (${r.statement})` : ""}: scored ${r.score ?? "nothing"}; evidence: ${r.evidence ?? "none"}`,
      ),
      `  the team's note: ${w.note ?? "none given"}`,
    ]),
  ];
}

/** The plan as a plain report: what was recorded, the work, the calibration notes. */
export function renderPlan(
  plan: FeedbackPlan,
  opts: { record: string; dryRun: boolean },
): string {
  return `${[
    ...recordedLines(plan, opts.record, opts.dryRun),
    ...driftLines(plan.drift),
    ...workLines(plan.work),
    ...calibrationLines(plan.wrong),
  ].join("\n")}\n`;
}

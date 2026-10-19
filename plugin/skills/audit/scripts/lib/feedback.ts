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
 *     profile_conditions: [M3, M12] # optional: the conditional targets that apply
 *     accept: [R1, R3]              # optional
 *     refine:                       # optional
 *       - { id: R2, note: "Use the existing lint job." }
 *     decline:                      # optional
 *       - { id: R4, refs: ["M5/<id>"], reason: "…", revisit_when: "…" }
 *     wrong:                        # optional
 *       - { id: R5, refs: ["M2/<id>"], note: "…" }
 *     scores:                       # optional: criteria whose score is wrong
 *       - { ref: "M3/<id>", note: "…" }
 *
 * A decline becomes an entry in the record's `declined:` list, or renews the
 * entry that already declines the same refs, a profile choice sets
 * `profile:`, and `profile_conditions` replaces the record's list (an empty
 * one removes it). Accepted and refined recommendations become the work,
 * ranked as the sheet's Start here ranks them. A wrong recommendation and a
 * wrong score are calibration notes: the audit misjudged something, so the
 * criterion's score is left for the agent to re-examine and never changed
 * here.
 *
 * The block is checked against the audit it was written for: the report's
 * repository and the fingerprint of its recommendations, the record's commit
 * (and, for a sheet, the commit of the record it was rendered with), the
 * report's recommendation ids and each one's refs, the criteria the record
 * scored, and the conditional targets of the profile that will apply (or of
 * the record's heading-to profile, as the record itself allows). A
 * recommendation the report marks applied takes no decision, so a block
 * that decides one is refused. A block written for another audit changes
 * nothing.
 */
import { isMapping } from "../../../../shared/config-layers.ts";
import { load } from "../../../../shared/yaml.ts";
import { type Module, NOT_EXAMINED, type Score } from "./criteria.ts";
import { extractEmbedded } from "../../../decide/scripts/sheet-kit/html.ts";
import { DATA_BLOCK_ID, parseEmbedded } from "../report/data.ts";
import { LIGHTER_PREFIX } from "../report/feedback-text.ts";
import { ranked } from "../report/model.ts";
import {
  parseReportSource,
  type Recommendation as SourceRecommendation,
  reportFingerprint,
} from "../report/source.ts";
import { beyondTarget, examinedTargets, type Profiles } from "./profiles.ts";
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
  /** Present only when the reader chose which conditional targets apply. */
  profile_conditions?: string[];
  accept: string[];
  refine: { id: string; note?: string }[];
  decline: {
    id: string;
    refs: string[];
    reason: string;
    revisit_when: string;
  }[];
  wrong: { id: string; refs: string[]; note?: string }[];
  /** Criteria whose score the reader says is wrong. */
  scores: { ref: string; note: string }[];
}

const START = /^(\s*)audit_feedback:\s*(#.*)?$/;

const indentOf = (line: string): number =>
  line.length - line.trimStart().length;

const isComment = (line: string): boolean => line.trimStart().startsWith("#");

const CRITERION_REF = /^M\d+\/[a-z0-9-]+$/;

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

function parseScore(raw: unknown, at: string): Feedback["scores"][number] {
  const s = strictMapping(raw, ["ref", "note"], at);
  if (typeof s.ref !== "string" || !CRITERION_REF.test(s.ref))
    refuse(`${at}.ref: a criterion is M<n>/<id>`);
  return { ref: s.ref, note: required(s.note, `${at}.note`) };
}

/** The values of `list` named more than once, each once. */
const repeated = (list: readonly string[]): string[] => [
  ...new Set(list.filter((v, i) => list.indexOf(v) !== i)),
];

function conditionsOf(v: unknown, at: string): string[] {
  if (!Array.isArray(v)) refuse(`${at} must list modules (M<n>)`);
  const modules = v.map((m, i) => {
    if (typeof m !== "string" || !/^M\d+$/.test(m))
      refuse(`${at}[${i}]: a module is M<n>`);
    return m;
  });
  const twice = repeated(modules);
  if (twice.length > 0) refuse(`${at}: ${twice.join(", ")} named twice`);
  return modules;
}

/** The block's optional profile and conditional targets, each only when written. */
function profileFields(
  f: Record<string, unknown>,
  at: string,
): Pick<Feedback, "profile" | "profile_conditions"> {
  return {
    ...(f.profile === undefined
      ? {}
      : { profile: required(f.profile, `${at}.profile`) }),
    ...(f.profile_conditions === undefined
      ? {}
      : {
          profile_conditions: conditionsOf(
            f.profile_conditions,
            `${at}.profile_conditions`,
          ),
        }),
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
  "profile_conditions",
  "accept",
  "refine",
  "decline",
  "wrong",
  "scores",
];

/** Why a parsed block cannot stand: an id in two choices, a criterion flagged twice. */
function duplicates(feedback: Feedback): string[] {
  const ids = repeated(choiceIds(feedback));
  const refs = repeated(feedback.scores.map((s) => s.ref));
  return [
    ...(ids.length > 0
      ? [`${ids.join(", ")}: one choice per recommendation`]
      : []),
    ...(refs.length > 0 ? [`${refs.join(", ")}: one note per criterion`] : []),
  ];
}

/**
 * Parse a feedback block, tolerating text pasted around it. Throws
 * `FeedbackRefused` for a block that is not one: an unknown key, an id that
 * is not R<n> or appears in two choices, a decline without its refs, reason
 * or revisit condition, a condition that is not a module or is named twice,
 * a score flag without its criterion or note, or a criterion flagged twice.
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
    ...profileFields(f, at),
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
    scores: listOf(f.scores, `${at}.scores`).map((s, i) =>
      parseScore(s, `${at}.scores[${i}]`),
    ),
  };
  const problems = duplicates(feedback);
  if (problems.length > 0) throw new FeedbackRefused(problems);
  return feedback;
}

/** A recommendation, as the report source states it. */
export type Recommendation = Pick<
  SourceRecommendation,
  | "id"
  | "refs"
  | "title"
  | "action"
  | "leverage"
  | "effort"
  | "quick_win"
  | "status"
  | "applied_in"
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

/** A criterion with what the record holds for it; a configuration finding has no score. */
export interface Recorded {
  ref: string;
  statement: string | null;
  score: Score | null;
  evidence: string | null;
}

export interface CalibrationNote {
  id: string;
  title: string;
  note?: string;
  refs: Recorded[];
}

/** A criterion whose score the team says is wrong, with its note. */
export interface ScoreNote extends Recorded {
  note: string;
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
  /** The record's `profile_conditions` and the list that replaces it, when the set changes. */
  conditions: { from: string[]; to: string[] } | null;
  /** Drift the report found: fixed first, before any module work. */
  drift: ReportView["drift"];
  /** Accepted and refined recommendations, in the order to take them. */
  work: WorkItem[];
  wrong: CalibrationNote[];
  /** Scores the team says are wrong: calibration notes, never changed here. */
  scores: ScoreNote[];
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

/** A decision on a recommendation already applied: it is done, so there is nothing to decide. */
function appliedChoices(
  feedback: Feedback,
  byId: ReadonlyMap<string, Recommendation>,
): string[] {
  return choiceIds(feedback).flatMap((id) => {
    const rec = byId.get(id);
    return rec?.status === "applied"
      ? [
          `${id}: the report marks it applied in ${rec.applied_in ?? "an earlier change"}; it takes no decision`,
        ]
      : [];
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

/**
 * The profile and conditional targets the block would leave the record
 * with, checked as the record's own are: every condition is a conditional
 * target of the profile that will apply, or of the heading-to profile.
 */
function profileProblems(feedback: Feedback, ctx: PlanContext): string[] {
  const { profile, profile_conditions } = feedback;
  if (profile === undefined && profile_conditions === undefined) return [];
  return checkProfile(
    {
      ...ctx.record,
      ...(profile === undefined ? {} : { profile }),
      ...(profile_conditions === undefined ? {} : { profile_conditions }),
    },
    ctx.profiles,
  );
}

/**
 * The criteria the audit left unexamined that the profile the block chooses
 * would need scored: within its target, a condition's or the heading-to
 * profile's. The record cannot hold that profile until they are scored.
 */
function unexaminedForProfile(feedback: Feedback, ctx: PlanContext): string[] {
  const { profile, profile_conditions } = feedback;
  if (profile === undefined && profile_conditions === undefined) return [];
  const id = profile ?? ctx.record.profile;
  const chosen = id === undefined ? undefined : ctx.profiles.profiles.get(id);
  if (!chosen) return [];
  const heading =
    ctx.record.heading_to === undefined
      ? undefined
      : ctx.profiles.profiles.get(ctx.record.heading_to);
  const targets = examinedTargets(
    chosen,
    profile_conditions ?? ctx.record.profile_conditions,
    heading,
  );
  const keys = ctx.modules
    .flatMap((m) => m.criteria)
    .filter(
      (c) =>
        ctx.record.criteria.get(c.key)?.score === NOT_EXAMINED &&
        !beyondTarget(c, targets),
    )
    .map((c) => c.key);
  return keys.length === 0
    ? []
    : [
        `${chosen.name}${profile_conditions?.length ? ` with ${profile_conditions.join(", ")}` : ""} reaches criteria the audit did not examine: ${keys.join(", ")}; score them in the record first, then record the block again`,
      ];
}

/** A score flag on a criterion the record does not hold. */
function unknownScores(feedback: Feedback, record: AuditRecord): string[] {
  return feedback.scores
    .filter((s) => !record.criteria.has(s.ref))
    .map((s) => `${s.ref}: the record has no such criterion`);
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
    ...appliedChoices(feedback, byId),
    ...refsProblems(feedback, byId),
    ...staleDeclines(feedback, ctx.modules),
    ...conflictingDeclines(feedback),
    ...heldWork(feedback, ctx),
    ...profileProblems(feedback, ctx),
    ...unexaminedForProfile(feedback, ctx),
    ...unknownScores(feedback, record),
  ];
}

/**
 * The accepted and refined recommendations, ranked as the sheet ranks its
 * Start here (`ranked`): leverage × effort, then a quick win, then the
 * report's own order.
 */
function workOf(
  feedback: Feedback,
  recommendations: readonly Recommendation[],
): WorkItem[] {
  const chosen = new Map<string, Pick<WorkItem, "choice" | "note">>([
    ...feedback.accept.map(
      (id) => [id, { choice: "accept" as const }] as const,
    ),
    ...feedback.refine.map(
      (r) =>
        [
          r.id,
          {
            choice: "refine" as const,
            ...(r.note === undefined ? {} : { note: r.note }),
          },
        ] as const,
    ),
  ]);
  return ranked(
    recommendations.flatMap((rec) => {
      const c = chosen.get(rec.id);
      return c ? [{ ...rec, ...c }] : [];
    }),
  );
}

/** What the record and the criteria hold for each ref. */
function recordedFor(ctx: PlanContext): (ref: string) => Recorded {
  const statements = new Map(
    ctx.modules.flatMap((m) => m.criteria.map((c) => [c.key, c.statement])),
  );
  return (ref) => {
    const entry = ctx.record.criteria.get(ref);
    return {
      ref,
      statement: statements.get(ref) ?? null,
      score: entry?.score ?? null,
      evidence: entry?.evidence ?? null,
    };
  };
}

function calibrationOf(
  feedback: Feedback,
  ctx: PlanContext,
  byId: ReadonlyMap<string, Recommendation>,
): Pick<FeedbackPlan, "wrong" | "scores"> {
  const recorded = recordedFor(ctx);
  return {
    wrong: feedback.wrong.map((w) => ({
      id: w.id,
      title: byId.get(w.id)?.title ?? w.id,
      ...(w.note === undefined ? {} : { note: w.note }),
      refs: w.refs.map(recorded),
    })),
    scores: feedback.scores.map((s) => ({ ...recorded(s.ref), note: s.note })),
  };
}

/** The conditional targets the block sets, when they differ from the record's. */
function conditionsChange(
  feedback: Feedback,
  record: AuditRecord,
): FeedbackPlan["conditions"] {
  const to = feedback.profile_conditions;
  const from = record.profile_conditions ?? [];
  return to === undefined || sameRefs(from, to) ? null : { from, to };
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
 * What recording `feedback` does: the declines to add, the profile and
 * conditional targets to set, the ordered work and the calibration notes.
 * Throws `FeedbackRefused` when the block was not written for this audit,
 * names a recommendation the report does not have, or names refs, criteria,
 * a profile or conditions that do not fit.
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
    conditions: conditionsChange(feedback, ctx.record),
    drift: ctx.report.drift,
    work: workOf(feedback, ctx.report.recommendations),
    ...calibrationOf(feedback, ctx, byId),
  };
}

/** Whether recording the plan changes the record. */
export function changesRecord(plan: FeedbackPlan): boolean {
  return (
    plan.profile !== null ||
    plan.conditions !== null ||
    plan.declined.length > 0
  );
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

/** Insert `line` after the first of the top-level `keys` the record has. */
function insertAfter(lines: string[], keys: readonly string[], line: string) {
  const after = keys.map((k) => topLevel(lines, k)).find((i) => i >= 0);
  lines.splice((after ?? -1) + 1, 0, line);
}

function setProfile(lines: string[], id: string): void {
  const at = topLevel(lines, "profile");
  if (at >= 0) {
    lines[at] = `profile: ${id}${splitLine(lines[at] ?? "", "profile").tail}`;
    return;
  }
  insertAfter(lines, ["shape", "commit"], `profile: ${id}`);
}

/** The comments among `lines`: a comment line as it is, a comment at a line's end on a line of its own. */
function commentsIn(lines: readonly string[], indent = ""): string[] {
  return lines.flatMap((line) => {
    if (isComment(line)) return [line];
    const at = commentAt(line);
    return at < 0 ? [] : [`${indent}${line.slice(at)}`];
  });
}

/**
 * Set `profile_conditions:` to `modules`: replace the key's value, in
 * whichever form it is written (a flow list over several lines too), add the
 * key after `profile:` when it is absent, or remove it for an empty list. The
 * comments it carried stay.
 */
function setConditions(lines: string[], modules: readonly string[]): void {
  const key = "profile_conditions";
  const value = `${key}: [${modules.join(", ")}]`;
  const at = topLevel(lines, key);
  if (at < 0) {
    if (modules.length > 0)
      insertAfter(lines, ["profile", "shape", "commit"], value);
    return;
  }
  const { value: was, tail } = splitLine(lines[at] ?? "", key);
  // A block list's items belong to the key and go with it.
  const first = was === "" ? nextContent(lines, at) : -1;
  const items = first >= 0 && /^\s*-(\s|$)/.test(lines[first] ?? "");
  const indent = items ? indentOf(lines[first] ?? "") : 0;
  const end = items ? blockEnd(lines, first, indent) : flowEnd(lines, at, was);
  const kept = commentsIn(lines.slice(at + 1, end), " ".repeat(indent));
  const own =
    modules.length > 0 ? [`${value}${tail}`] : tail ? [tail.trimStart()] : [];
  lines.splice(at, end - at, ...own, ...kept);
}

/**
 * The index after the line that closes the flow list `was`, the value that
 * opens on line `at`; the line after `at` for any other value. Brackets inside
 * a comment do not count.
 */
function flowEnd(lines: readonly string[], at: number, was: string): number {
  if (!was.startsWith("[")) return at + 1;
  let depth = 0;
  for (let i = at; i < lines.length; i++) {
    depth += bracketsOpened(i === at ? was : (lines[i] ?? ""));
    if (depth <= 0) return i + 1;
  }
  return at + 1;
}

/** The brackets a line leaves open: each `[` before its comment adds one, each `]` takes one away. */
function bracketsOpened(line: string): number {
  const hash = commentAt(line);
  const code = hash < 0 ? line : line.slice(0, hash);
  const count = (pattern: RegExp) => code.match(pattern)?.length ?? 0;
  return count(/\[/g) - count(/\]/g);
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
  const comments = commentsIn(lines.slice(start, end), " ".repeat(indent));
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
 * profile and conditional targets set. The text is edited line by line
 * rather than re-serialised, so every comment in the record is kept.
 */
export function editRecordText(source: string, plan: FeedbackPlan): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  if (plan.profile) setProfile(lines, plan.profile.to);
  if (plan.conditions) setConditions(lines, plan.conditions.to);
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

const refList = (refs: readonly string[]): string => `[${refs.join(", ")}]`;

/** The profile and conditional targets an edited record does not read as the plan set them. */
function profileEdited(after: AuditRecord, plan: FeedbackPlan): string[] {
  const problems: string[] = [];
  if (plan.profile && after.profile !== plan.profile.to)
    problems.push(
      `profile: reads ${after.profile ?? "nothing"}, not ${plan.profile.to}`,
    );
  const now = after.profile_conditions ?? [];
  if (plan.conditions && !sameRefs(now, plan.conditions.to))
    problems.push(
      `profile_conditions: reads ${refList(now)}, not ${refList(plan.conditions.to)}`,
    );
  return problems;
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
  const problems = [
    ...checkRecord(after, catalog.modules, catalog.profiles).filter(
      (p) => !known.has(p),
    ),
    ...profileEdited(after, plan),
  ];
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

/** The conditional targets now recorded, and which began or stopped applying. */
function conditionsLine(c: NonNullable<FeedbackPlan["conditions"]>): string {
  const added = c.to.filter((m) => !c.from.includes(m));
  const removed = c.from.filter((m) => !c.to.includes(m));
  const what = [
    ...(added.length > 0 ? [`now applies: ${added.join(", ")}`] : []),
    ...(removed.length > 0 ? [`no longer applies: ${removed.join(", ")}`] : []),
  ];
  return `- profile_conditions: ${c.to.length > 0 ? refList(c.to) : "none"} (${what.join("; ")})`;
}

function recordedLines(
  plan: FeedbackPlan,
  record: string,
  dryRun: boolean,
): string[] {
  const changes = [
    ...plan.declined.map(
      (d) =>
        `- ${d.replaces === undefined ? "declined" : "declined again"} ${d.id} ${refList(d.entry.refs)}: ${d.entry.reason} (revisit: ${d.entry.revisit_when})`,
    ),
    ...(plan.profile
      ? [
          `- profile: ${plan.profile.to} (was ${plan.profile.from ?? "not set"})`,
        ]
      : []),
    ...(plan.conditions ? [conditionsLine(plan.conditions)] : []),
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
    "Work, ranked as the sheet's Start here (ready for /jig:audit apply <ref> ..., together, or for filing):",
    ...work.map(
      (w, i) => `${i + 1}. ${w.id} ${refList(w.refs)} ${workText(w)}`,
    ),
  ];
}

/** A criterion as the record holds it: its statement, score and evidence. */
const recordedText = (r: Recorded): string =>
  `${r.ref}${r.statement ? ` (${r.statement})` : ""}: scored ${r.score ?? "nothing"}; evidence: ${r.evidence ?? "none"}`;

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
          : `  ${recordedText(r)}`,
      ),
      `  the team's note: ${w.note ?? "none given"}`,
    ]),
  ];
}

function scoreLines(scores: readonly ScoreNote[]): string[] {
  if (scores.length === 0) return [];
  return [
    "",
    "This score is wrong (calibration notes: re-examine; the score is not changed):",
    ...scores.flatMap((s) => [
      `- ${recordedText(s)}`,
      `  the team's note: ${s.note}`,
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
    ...scoreLines(plan.scores),
  ].join("\n")}\n`;
}

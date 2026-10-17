/**
 * The report source: one JSON document the agent writes after scoring, holding
 * what the audit record does not: the summary, the ranked recommendations,
 * the gaps it leaves on purpose, the drift it found, what it examined and the
 * terms it used. The audit sheet
 * and its Markdown copy are rendered from this source together with the
 * record, the configuration-fit report and, on a re-audit, the prior record.
 *
 * Validation is strict: an unknown key is an error, so a typo cannot drop a
 * recommendation from every projection without a trace. Scores, levels and
 * configuration findings are never repeated here; `render` reads them from
 * the record and the fit report, and `inputProblems` (`model.ts`) checks
 * each recommendation against them.
 */
import { createHash } from "node:crypto";
import { isMapping } from "../../../../shared/config-layers.ts";
import type { GlossaryEntry } from "../../../decide/scripts/sheet-kit/inline.ts";
import { Checker } from "../../../decide/scripts/sheet-kit/source.ts";
import type { Severity } from "../lib/schema.ts";

export const LEVERAGE = ["high", "medium", "low"] as const;
export type Leverage = (typeof LEVERAGE)[number];
export const EFFORT = ["small", "medium", "large"] as const;
export type Effort = (typeof EFFORT)[number];
export const PROFILE_SOURCES = ["declared", "suggested"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];
/** What a recommendation needs that an agent working in the repository does not have. */
export const NEEDS = ["host-admin"] as const;
export type Needs = (typeof NEEDS)[number];

export interface Recommendation {
  /** `R<n>`: the id the team's decisions name. */
  id: string;
  /** The criteria (`M<n>/<id>`) or configuration findings (`config/<id>`) it moves. */
  refs: string[];
  title: string;
  finding: string;
  action: string;
  evidence: string[];
  leverage: Leverage;
  effort: Effort;
  quick_win?: boolean;
  /** A lighter way to most of the benefit, such as writing the rule down before building the gate. */
  lighter?: string;
  /** Set once the work is done after the audited commit: the sheet shows it as done, and it takes no decision. */
  status?: "applied";
  /** Where it was applied: a pull request (its URL or number) or a commit. Required with `status`. */
  applied_in?: string;
  /** `host-admin`: only someone who administers the repository on its host can apply it. */
  needs?: Needs;
}

/**
 * Gaps the audit leaves on purpose, and why: the criteria it names are not
 * warned of as uncovered, and the sheet lists them with the reason.
 */
export interface LeftOnPurpose {
  refs: string[];
  reason: string;
  revisit_when?: string;
}

/** A fact suggesting the team revisit its profile: more contributors, a deploy environment, a compliance document. */
export interface ProfileSignal {
  text: string;
  evidence: string[];
}

export interface ReportSource {
  v: 1;
  repository: { name: string; url?: string };
  summary: string;
  /**
   * The profile the team declared (it is the record's), or one the audit
   * suggests and why, with the facts that suggest the project has outgrown it.
   */
  profile?: {
    id: string;
    source: ProfileSource;
    why?: string;
    signals?: ProfileSignal[];
  };
  examined: { read: string[]; unchecked?: { what: string; why: string }[] };
  stack: { facet: string; detected: string; evidence: string }[];
  recommendations: Recommendation[];
  left_on_purpose?: LeftOnPurpose[];
  drift?: { text: string; evidence: string[] }[];
  terms?: GlossaryEntry[];
}

export class ReportSourceError extends Error {
  readonly problems: string[];
  constructor(problems: string[], what = "invalid report source") {
    super(`${what}:\n- ${problems.join("\n- ")}`);
    this.name = "ReportSourceError";
    this.problems = problems;
  }
}

export const REC_ID = /^R[1-9]\d*$/;
export const CRITERION_REF = /^M\d+\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONFIG_REF = /^config\/.+$/;
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A repository name is one line: it heads the decisions block as a comment. */
const ONE_LINE = /^[^\r\n\u2028\u2029]+$/;
/** Where a recommendation was applied: a pull request's number (`53`, `#53`) or a commit. A URL is checked as one. */
const APPLIED_IN = /^(#?[1-9]\d*|[0-9a-f]{7,40})$/;

function checkOneOf(
  c: Checker,
  value: unknown,
  allowed: readonly string[],
  path: string,
): void {
  if (!allowed.includes(value as string))
    c.fail(path, `must be ${allowed.join(" | ")}`);
}

function checkRefs(c: Checker, refs: unknown, path: string): void {
  if (!c.array(refs, path, 1)) return;
  refs.forEach((ref, i) => {
    if (
      typeof ref !== "string" ||
      !(CRITERION_REF.test(ref) || CONFIG_REF.test(ref))
    )
      c.fail(`${path}[${i}]`, "must be M<n>/<criterion id> or config/<id>");
  });
  if (new Set(refs).size !== refs.length) c.fail(path, "names a ref twice");
}

const REC_FIELDS = [
  "id",
  "refs",
  "title",
  "finding",
  "action",
  "evidence",
  "leverage",
  "effort",
];

const REC_OPTIONAL = ["quick_win", "lighter", "status", "applied_in", "needs"];

/** `status: applied` and where: a pull request's URL or number, or a commit. */
function checkApplied(c: Checker, r: Record<string, unknown>, p: string): void {
  if ("status" in r && r.status !== "applied")
    c.fail(
      `${p}.status`,
      "must be applied, or left out while the work is open",
    );
  if (!("applied_in" in r)) {
    if (r.status === "applied")
      c.fail(`${p}.applied_in`, "is required for an applied recommendation");
    return;
  }
  if (r.status !== "applied")
    c.fail(`${p}.applied_in`, 'needs "status": "applied"');
  const at = r.applied_in;
  if (typeof at === "string" && at.startsWith("https://"))
    c.url(at, `${p}.applied_in`);
  else
    c.pattern(
      at,
      APPLIED_IN,
      `${p}.applied_in`,
      "a pull request's URL or number, or a commit",
    );
}

function checkRecommendation(c: Checker, r: unknown, p: string): void {
  if (!c.object(r, p, REC_FIELDS, REC_OPTIONAL)) return;
  c.optionalText(r, "lighter", p);
  c.pattern(r.id, REC_ID, `${p}.id`, "R<n>, such as R1");
  checkRefs(c, r.refs, `${p}.refs`);
  for (const k of ["title", "finding", "action"]) c.text(r[k], `${p}.${k}`);
  c.texts(r.evidence, `${p}.evidence`, 1);
  checkOneOf(c, r.leverage, LEVERAGE, `${p}.leverage`);
  checkOneOf(c, r.effort, EFFORT, `${p}.effort`);
  if ("quick_win" in r && typeof r.quick_win !== "boolean")
    c.fail(`${p}.quick_win`, "must be true or false");
  checkApplied(c, r, p);
  if ("needs" in r) checkOneOf(c, r.needs, NEEDS, `${p}.needs`);
}

function checkRecommendations(c: Checker, value: unknown): void {
  if (!c.array(value, "$.recommendations", 0)) return;
  value.forEach((r, i) => {
    checkRecommendation(c, r, `$.recommendations[${i}]`);
  });
  const ids = value.map((r) => (isMapping(r) ? r.id : undefined));
  if (new Set(ids).size !== ids.length)
    c.fail("$.recommendations", "has a duplicate id");
}

function checkProfile(c: Checker, value: unknown): void {
  if (!c.object(value, "$.profile", ["id", "source"], ["why", "signals"]))
    return;
  c.pattern(value.id, PROFILE_ID, "$.profile.id", "a profile id");
  checkOneOf(c, value.source, PROFILE_SOURCES, "$.profile.source");
  if ("why" in value) c.text(value.why, "$.profile.why");
  else if (value.source === "suggested")
    c.fail("$.profile.why", "is required for a suggested profile");
  if ("signals" in value) checkFacts(c, value.signals, "$.profile.signals");
}

function checkExamined(c: Checker, value: unknown): void {
  if (!c.object(value, "$.examined", ["read"], ["unchecked"])) return;
  c.texts(value.read, "$.examined.read", 1);
  if (
    "unchecked" in value &&
    c.array(value.unchecked, "$.examined.unchecked", 1)
  )
    value.unchecked.forEach((u, i) => {
      const p = `$.examined.unchecked[${i}]`;
      if (c.object(u, p, ["what", "why"], [])) {
        c.text(u.what, `${p}.what`);
        c.text(u.why, `${p}.why`);
      }
    });
}

function checkStack(c: Checker, value: unknown): void {
  if (!c.array(value, "$.stack", 1)) return;
  value.forEach((s, i) => {
    const p = `$.stack[${i}]`;
    if (c.object(s, p, ["facet", "detected", "evidence"], []))
      for (const k of ["facet", "detected", "evidence"])
        c.text(s[k], `${p}.${k}`);
  });
}

/** A list of facts, each a text with at least one piece of evidence: the drift found, the profile's signals. */
function checkFacts(c: Checker, value: unknown, path: string): void {
  if (!c.array(value, path, 1)) return;
  value.forEach((d, i) => {
    const p = `${path}[${i}]`;
    if (c.object(d, p, ["text", "evidence"], [])) {
      c.text(d.text, `${p}.text`);
      c.texts(d.evidence, `${p}.evidence`, 1);
    }
  });
}

/** Gaps left on purpose: each names criteria and says why. */
function checkLeftOnPurpose(c: Checker, value: unknown): void {
  const path = "$.left_on_purpose";
  if (!c.array(value, path, 1)) return;
  value.forEach((l, i) => {
    const p = `${path}[${i}]`;
    if (!c.object(l, p, ["refs", "reason"], ["revisit_when"])) return;
    if (c.array(l.refs, `${p}.refs`, 1)) {
      l.refs.forEach((ref, j) => {
        if (typeof ref !== "string" || !CRITERION_REF.test(ref))
          c.fail(`${p}.refs[${j}]`, "must be M<n>/<criterion id>");
      });
      if (new Set(l.refs).size !== l.refs.length)
        c.fail(`${p}.refs`, "names a ref twice");
    }
    c.text(l.reason, `${p}.reason`);
    c.optionalText(l, "revisit_when", p);
  });
}

function checkRepository(c: Checker, value: unknown): void {
  if (!c.object(value, "$.repository", ["name"], ["url"])) return;
  c.pattern(value.name, ONE_LINE, "$.repository.name", "one line");
  if ("url" in value) c.url(value.url, "$.repository.url");
}

/** Validate an unknown JSON value and return it typed, or throw listing every problem. */
export function parseReportSource(value: unknown): ReportSource {
  const c = new Checker();
  const required = [
    "v",
    "repository",
    "summary",
    "examined",
    "stack",
    "recommendations",
  ];
  const optional = ["profile", "left_on_purpose", "drift", "terms"];
  if (!c.object(value, "$", required, optional))
    throw new ReportSourceError(c.problems);
  if (value.v !== 1) c.fail("$.v", "must be 1");
  checkRepository(c, value.repository);
  c.text(value.summary, "$.summary");
  if ("profile" in value) checkProfile(c, value.profile);
  checkExamined(c, value.examined);
  checkStack(c, value.stack);
  checkRecommendations(c, value.recommendations);
  if ("left_on_purpose" in value) checkLeftOnPurpose(c, value.left_on_purpose);
  if ("drift" in value) checkFacts(c, value.drift, "$.drift");
  if ("terms" in value) c.glossary(value.terms, "$.terms");
  if (c.problems.length > 0) throw new ReportSourceError(c.problems);
  return value as unknown as ReportSource;
}

// ---------- the configuration-fit report ----------

const SEVERITIES: readonly Severity[] = [
  "error",
  "warning",
  "suggestion",
  "info",
];

export interface FitFinding {
  id: string;
  severity: Severity;
  message: string;
}

/** Another profile the repository's facts would also support, and why. */
export interface AlternativeProfile {
  id: string;
  why: string[];
}

/**
 * What the sheet reads of `config-fit.ts --json`, with the starter
 * configuration when it printed one and, of its profile facts, the
 * alternative profile when it names one.
 */
export interface Fit {
  file: string;
  configured: boolean;
  forge: string;
  facts: Record<string, string>;
  findings: FitFinding[];
  declined: { finding: FitFinding; reason: string; revisit_when: string }[];
  draft?: string;
  profile_facts?: { alternative: AlternativeProfile };
}

function parseFinding(raw: unknown, at: string): FitFinding {
  if (
    !isMapping(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.message !== "string" ||
    !SEVERITIES.includes(raw.severity as Severity)
  )
    throw new Error(`${at}: a finding has an id, a severity and a message`);
  return {
    id: raw.id,
    severity: raw.severity as Severity,
    message: raw.message,
  };
}

function parseFitDeclined(raw: unknown, at: string): Fit["declined"][number] {
  if (
    !isMapping(raw) ||
    typeof raw.reason !== "string" ||
    typeof raw.revisit_when !== "string"
  )
    throw new Error(`${at}: a declined finding has a reason and revisit_when`);
  return {
    finding: parseFinding(raw.finding, `${at}.finding`),
    reason: raw.reason,
    revisit_when: raw.revisit_when,
  };
}

function parseFacts(raw: unknown, file: string): Record<string, string> {
  if (!isMapping(raw)) throw new Error(`${file}: facts must be a mapping`);
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, String(v)]),
  );
}

/** A configuration-fit report whose profile facts are of another shape. */
class FitShapeError extends Error {
  override name = "FitShapeError";
}

/** The alternative profile of the report's profile facts, when it names one. */
function parseAlternative(
  raw: unknown,
  file: string,
): AlternativeProfile | null {
  if (!isMapping(raw) || raw.alternative === undefined) return null;
  const a = raw.alternative;
  if (
    !isMapping(a) ||
    typeof a.id !== "string" ||
    !PROFILE_ID.test(a.id) ||
    !Array.isArray(a.why) ||
    !a.why.every((w) => typeof w === "string" && w.trim() !== "")
  )
    throw new FitShapeError(
      `${file}: profile_facts.alternative has a profile id and a list of reasons (why)`,
    );
  return { id: a.id, why: a.why as string[] };
}

/** Read a configuration-fit report; a file of another shape is an error naming what is wrong. */
export function parseFit(raw: unknown, file: string): Fit {
  if (
    !isMapping(raw) ||
    typeof raw.file !== "string" ||
    typeof raw.configured !== "boolean" ||
    typeof raw.forge !== "string"
  )
    throw new Error(
      `${file}: not a configuration-fit report (config-fit.ts --json)`,
    );
  if (!Array.isArray(raw.findings) || !Array.isArray(raw.declined ?? []))
    throw new Error(`${file}: findings and declined must be lists`);
  if (
    raw.draft !== undefined &&
    raw.draft !== null &&
    typeof raw.draft !== "string"
  )
    throw new Error(`${file}: draft must be text`);
  const alternative = parseAlternative(raw.profile_facts, file);
  return {
    file: raw.file,
    configured: raw.configured,
    forge: raw.forge,
    facts: parseFacts(raw.facts ?? {}, file),
    findings: raw.findings.map((f, i) =>
      parseFinding(f, `${file}: findings[${i}]`),
    ),
    declined: ((raw.declined ?? []) as unknown[]).map((d, i) =>
      parseFitDeclined(d, `${file}: declined[${i}]`),
    ),
    ...(typeof raw.draft === "string" && raw.draft.trim() !== ""
      ? { draft: raw.draft }
      : {}),
    ...(alternative ? { profile_facts: { alternative } } : {}),
  };
}

/**
 * What identifies a report's recommendations: every field a decision is made
 * on. A decision names a recommendation by id, and ids are only numbers, so a
 * decision made on one version of a report must not reach another whose R3
 * is a different recommendation, or the same one asking for different work.
 * Whether it is applied, and what it needs, count too; a recommendation
 * without them hashes as it always has.
 */
export function reportFingerprint(
  recommendations: readonly Recommendation[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        recommendations.map((r) => [
          r.id,
          r.refs,
          r.title,
          r.finding,
          r.action,
          r.evidence,
          r.leverage,
          r.effort,
          r.quick_win ?? false,
          r.lighter ?? null,
          ...(r.status || r.needs
            ? [
                {
                  status: r.status ?? null,
                  applied_in: r.applied_in ?? null,
                  needs: r.needs ?? null,
                },
              ]
            : []),
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 12);
}

/**
 * The audit record (`.config/jig-audit.yaml`): what an audit found, committed
 * in the audited repository so the next audit can compare against it.
 *
 *   version: 1
 *   plugin_version: 0.13.0     # the plugin that ran the audit
 *   date: 2026-10-12
 *   commit: <full sha>          # the commit audited
 *   shape: library              # library | application | service | monorepo | documentation | infrastructure | …; calibrates expected-absent
 *   profile: team-standard      # optional: the profile the team aims for (profiles.yaml)
 *   profile_conditions: [M12]   # optional: the conditional targets that apply
 *   heading_to: regulated-strict  # optional: the profile the project is growing toward
 *   criteria:
 *     M1/ci-runs-gates-on-pr:
 *       score: mechanical       # absent | convention | advisory | mechanical | expected-absent | not-examined
 *       evidence: .github/workflows/ci.yml runs the gates; required on main
 *   declined:                   # recommendations the team chose not to take
 *     - refs: [M1/precommit-autofix-hooks]
 *       reason: The editor formats on save and CI checks formatting.
 *       revisit_when: Formatting failures reach CI more than once a month.
 *       revisit_after: 2027-04-01   # optional: raise it again after this date
 *
 * A declined entry's `refs` name criteria (`M<n>/<id>`) or configuration
 * findings (`config/<finding id>`). A criterion beyond the profile's target
 * may be `not-examined`; once the record declares a profile, every criterion
 * within its target (and the heading-to profile's) must be scored.
 */
import { isMapping as isRecord } from "../../../../shared/config-layers.ts";
import { beyondTarget, examinedTargets, type Profiles } from "./profiles.ts";
import { load } from "../../../../shared/yaml.ts";
import {
  type Attainment,
  attained,
  attainedAsOf,
  type Criterion,
  EXPECTED_ABSENT,
  meets,
  type Module,
  NOT_EXAMINED,
  rank,
  type Rung,
  RUNGS,
  type Score,
  SCORES,
} from "./criteria.ts";
import type { Schema } from "./schema.ts";
import { compareVersions, isDate, run, VERSION_PATTERN } from "./repo.ts";

export const RECORD_RELPATH = ".config/jig-audit.yaml";

export interface Declined {
  refs: string[];
  reason: string;
  revisit_when: string;
  revisit_after?: string;
  /** Keys the entry carries that the record does not define, kept so rewriting the entry keeps them. */
  other?: Record<string, unknown>;
}

const DECLINED_KEYS = new Set([
  "refs",
  "reason",
  "revisit_when",
  "revisit_after",
]);

export interface AuditRecord {
  version: 1;
  plugin_version: string;
  date: string;
  commit: string;
  shape?: string;
  profile?: string;
  profile_conditions?: string[];
  /** The profile the project is growing toward, when the team names one. */
  heading_to?: string;
  criteria: Map<string, Scored>;
  declined: Declined[];
}

const text = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";

/** A YAML date without quotes parses as a Date; read both forms as text. */
function isoDate(v: unknown): unknown {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v;
}

/** The record's optional `profile` and `profile_conditions`. */
function parseProfileFields(
  raw: Record<string, unknown>,
  file: string,
): Pick<AuditRecord, "profile" | "profile_conditions" | "heading_to"> {
  if (raw.profile !== undefined && raw.profile !== null && !text(raw.profile))
    throw new Error(`${file}: profile must be a profile id`);
  if (
    raw.heading_to !== undefined &&
    raw.heading_to !== null &&
    !text(raw.heading_to)
  )
    throw new Error(`${file}: heading_to must be a profile id`);
  const conditions = raw.profile_conditions ?? [];
  if (
    !Array.isArray(conditions) ||
    !conditions.every((m) => typeof m === "string" && /^M\d+$/.test(m))
  )
    throw new Error(`${file}: profile_conditions must list modules (M<n>)`);
  return {
    ...(text(raw.profile) ? { profile: raw.profile } : {}),
    ...(text(raw.heading_to) ? { heading_to: raw.heading_to } : {}),
    ...(conditions.length > 0
      ? { profile_conditions: conditions as string[] }
      : {}),
  };
}

/**
 * One criterion's entry. `at_most` is the highest rung its probe allows: a
 * probe a higher rung needs found nothing at the audited commit.
 */
export type Scored = {
  score: Score | null;
  evidence: string | null;
  at_most?: Rung;
};

function parseCriteria(raw: unknown, file: string): Map<string, Scored> {
  if (!isRecord(raw)) throw new Error(`${file}: criteria must be a mapping`);
  const criteria = new Map<string, Scored>();
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^M\d+\/[a-z0-9-]+$/.test(key))
      throw new Error(`${file}: ${key} is not a criterion key (M<n>/<id>)`);
    criteria.set(key, parseEntry(entry, `${file}: ${key}`));
  }
  return criteria;
}

/** One criterion's entry; `at` names it in an error. */
function parseEntry(entry: unknown, at: string): Scored {
  if (!isRecord(entry)) throw new Error(`${at} must be a mapping`);
  const score = entry.score ?? null;
  if (score !== null && !(SCORES as readonly unknown[]).includes(score))
    throw new Error(`${at}.score must be ${SCORES.join(" | ")}`);
  const evidence = entry.evidence ?? null;
  if (evidence !== null && typeof evidence !== "string")
    throw new Error(`${at}.evidence must be text`);
  const atMost = entry.at_most;
  if (atMost !== undefined && !(RUNGS as readonly unknown[]).includes(atMost))
    throw new Error(`${at}.at_most must be ${RUNGS.join(" | ")}`);
  return {
    score: score as Score | null,
    evidence,
    ...(atMost === undefined ? {} : { at_most: atMost as Rung }),
  };
}

/** What a declined entry's ref names: a criterion or a configuration finding. */
export const DECLINED_REF = /^(M\d+\/[a-z0-9-]+|config\/.+)$/;

function isJsonValue(v: unknown): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean")
    return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(isJsonValue);
  return isRecord(v) && Object.values(v).every(isJsonValue);
}

/**
 * Whether a list or mapping is reached twice. YAML aliases share one node, so
 * a few lines can name a cycle or an exponentially large expansion; walking
 * each node once keeps the check, and the JSON written afterwards, bounded.
 */
function sharesNode(v: unknown, seen: Set<object>): boolean {
  if (typeof v !== "object" || v === null) return false;
  if (seen.has(v)) return true;
  seen.add(v);
  return Object.values(v).some((item) => sharesNode(item, seen));
}

/**
 * A declined entry's keys the record does not define. They are written back
 * and embedded as JSON, so a value JSON cannot hold as it is (a YAML date, an
 * infinite number, a list or mapping an alias repeats across these keys) would
 * come back changed, and is refused. A scalar alias resolves to a plain value
 * and is kept.
 */
function keptKeys(d: Record<string, unknown>, at: string): [string, unknown][] {
  const other = Object.entries(d).filter(([k]) => !DECLINED_KEYS.has(k));
  const seen = new Set<object>();
  for (const [key, value] of other) {
    if (sharesNode(value, seen))
      throw new Error(
        `${at}.${key} repeats a list or mapping through a YAML alias; write the value out`,
      );
    if (!isJsonValue(value))
      throw new Error(
        `${at}.${key} must be text, a finite number, true, false, null, or a list or mapping of those; quote a date`,
      );
  }
  return other;
}

function parseDeclined(d: unknown, at: string): Declined {
  if (!isRecord(d)) throw new Error(`${at} must be a mapping`);
  if (!Array.isArray(d.refs) || d.refs.length === 0 || !d.refs.every(text))
    throw new Error(`${at}.refs must list criteria or config findings`);
  for (const ref of d.refs as string[])
    if (!DECLINED_REF.test(ref))
      throw new Error(
        `${at}.refs: ${ref} is neither M<n>/<id> nor config/<finding>`,
      );
  if (!text(d.reason)) throw new Error(`${at}.reason is required`);
  if (!text(d.revisit_when)) throw new Error(`${at}.revisit_when is required`);
  const after = isoDate(d.revisit_after);
  if (
    after !== undefined &&
    after !== null &&
    (typeof after !== "string" || !isDate(after))
  )
    throw new Error(`${at}.revisit_after must be a calendar date, YYYY-MM-DD`);
  const other = keptKeys(d, at);
  return {
    refs: d.refs as string[],
    reason: d.reason,
    revisit_when: d.revisit_when,
    ...(typeof after === "string" ? { revisit_after: after } : {}),
    ...(other.length > 0 ? { other: Object.fromEntries(other) } : {}),
  };
}

/**
 * Parse a record. Shape errors throw; a record that parses but is incomplete
 * (an unscored criterion) is reported by `checkRecord`, so a draft can be
 * read while it is being filled in.
 */
export function parseRecord(source: string, file: string): AuditRecord {
  const raw = load(source);
  if (!isRecord(raw)) throw new Error(`${file}: must be a mapping`);
  if (raw.version !== 1) throw new Error(`${file}: version must be 1`);
  if (
    typeof raw.plugin_version !== "string" ||
    !VERSION_PATTERN.test(raw.plugin_version)
  )
    throw new Error(`${file}: plugin_version must be a version such as 0.13.0`);
  const date = isoDate(raw.date);
  if (typeof date !== "string" || !isDate(date))
    throw new Error(`${file}: date must be a calendar date, YYYY-MM-DD`);
  if (!text(raw.commit)) throw new Error(`${file}: commit is required`);
  if (raw.shape !== undefined && raw.shape !== null && !text(raw.shape))
    throw new Error(`${file}: shape must be text`);
  const criteria = parseCriteria(raw.criteria ?? {}, file);
  const declinedRaw = raw.declined ?? [];
  if (!Array.isArray(declinedRaw))
    throw new Error(`${file}: declined must be a list`);
  return {
    version: 1,
    plugin_version: raw.plugin_version,
    date,
    commit: raw.commit,
    ...(text(raw.shape) ? { shape: raw.shape } : {}),
    ...parseProfileFields(raw, file),
    criteria,
    declined: declinedRaw.map((d, i) =>
      parseDeclined(d, `${file}: declined[${i}]`),
    ),
  };
}

/** What makes a record unfit to commit: unscored or unknown criteria, scores without evidence. */
export function checkRecord(
  record: AuditRecord,
  modules: Module[],
  profiles?: Profiles,
): string[] {
  const known = new Set(modules.flatMap((m) => m.criteria.map((c) => c.key)));
  return [
    ...(profiles ? checkProfile(record, profiles) : []),
    ...[...known].flatMap((key) => entryProblems(key, record)),
    ...(profiles ? unexaminedWithinTarget(record, modules, profiles) : []),
    ...[...record.criteria.keys()]
      .filter((key) => !known.has(key))
      .map((key) => `${key}: not a criterion of this plugin version`),
    ...record.declined
      .flatMap((d) => d.refs)
      .filter((ref) => ref.startsWith("M") && !known.has(ref))
      .map((ref) => `declined ${ref}: not a criterion of this plugin version`),
  ];
}

/** What is missing from one criterion's entry in the record, or scores it above its probe's ceiling. */
function entryProblems(key: string, record: AuditRecord): string[] {
  const entry = record.criteria.get(key);
  if (!entry) return [`${key}: missing`];
  if (entry.score === null) return [`${key}: not scored`];
  if (!text(entry.evidence)) return [`${key}: no evidence`];
  if (aboveCeiling(entry, entry.score)) return [ABOVE_CEILING(key, entry)];
  return [];
}

/** Whether `score` is a rung above the highest the entry's probe allows. */
export function aboveCeiling(entry: Scored, score: unknown): boolean {
  if (entry.at_most === undefined) return false;
  const at = RUNGS.indexOf(score as Rung);
  return at > RUNGS.indexOf(entry.at_most);
}

const ABOVE_CEILING = (key: string, entry: Scored): string =>
  `${key}: its probe allows at most ${entry.at_most}: what a higher rung needs is missing at the audited commit`;

/**
 * The criteria left `not-examined` that the record's profile needs examined:
 * within its target, a condition's or the heading-to profile's. Without a
 * declared profile, any criterion may be left unexamined.
 */
function unexaminedWithinTarget(
  record: AuditRecord,
  modules: Module[],
  profiles: Profiles,
): string[] {
  const profile =
    record.profile === undefined
      ? undefined
      : profiles.profiles.get(record.profile);
  if (!profile) return [];
  const heading =
    record.heading_to === undefined
      ? undefined
      : profiles.profiles.get(record.heading_to);
  const targets = examinedTargets(profile, record.profile_conditions, heading);
  return modules
    .flatMap((m) => m.criteria)
    .filter(
      (c) =>
        record.criteria.get(c.key)?.score === NOT_EXAMINED &&
        !beyondTarget(c, targets),
    )
    .map(
      (c) =>
        `${c.key}: not examined, but within the ${profile.name}${heading ? ` or ${heading.name}` : ""} target (${c.level}): score it`,
    );
}

/** The record's profile names a shipped profile, and its conditions are that profile's. */
export function checkProfile(
  record: AuditRecord,
  profiles: Profiles,
): string[] {
  const heading =
    record.heading_to !== undefined && !profiles.profiles.has(record.heading_to)
      ? [
          `heading_to: ${record.heading_to} is not one of ${[...profiles.profiles.keys()].join(", ")}`,
        ]
      : [];
  return [...heading, ...checkDeclaredProfile(record, profiles)];
}

function checkDeclaredProfile(
  record: AuditRecord,
  profiles: Profiles,
): string[] {
  if (record.profile === undefined)
    return record.profile_conditions?.length
      ? ["profile_conditions: set without a profile"]
      : [];
  const profile = profiles.profiles.get(record.profile);
  if (!profile)
    return [
      `profile: ${record.profile} is not one of ${[...profiles.profiles.keys()].join(", ")}`,
    ];
  // The conditions apply to the heading-to profile too, so one that only
  // the profile the project grows into makes conditional is the team's to state.
  const heading =
    record.heading_to === undefined
      ? undefined
      : profiles.profiles.get(record.heading_to);
  return (record.profile_conditions ?? [])
    .filter((m) => !profile.conditional.has(m) && !heading?.conditional.has(m))
    .map((m) =>
      heading
        ? `profile_conditions: neither ${profile.name} nor ${heading.name} has a conditional target for ${m}`
        : `profile_conditions: ${profile.name} has no conditional target for ${m}`,
    );
}

/** The scored criteria of a record, as `attained` reads them. */
export function scoresOf(record: AuditRecord): Map<string, Score> {
  const scores = new Map<string, Score>();
  for (const [key, entry] of record.criteria)
    if (entry.score !== null) scores.set(key, entry.score);
  return scores;
}

export type Change =
  | "fixed"
  | "regressed"
  | "still-open"
  | "unchanged"
  | "new"
  | "added-by-jig"
  | "reclassified"
  | "examined-since"
  | "no-longer-examined"
  | "not-examined"
  | "removed";

export interface CriterionChange {
  key: string;
  change: Change;
  prior: Score | null;
  current: Score | null;
}

export type DeclinedStatus = "held" | "due" | "resolved" | "stale";

export interface Comparison {
  criteria: CriterionChange[];
  declined: { entry: Declined; status: DeclinedStatus; why: string }[];
  /** Configuration fields the plugin added after the prior audit's version. */
  newFields: string[];
  levels: {
    module: string;
    prior: Attainment | null;
    current: Attainment | null;
  }[];
}

/** How a criterion scored both times changed against its pass bar. */
function scoredChange(
  before: Score,
  after: Score,
  requires: Criterion["requires"],
): Change {
  // Into or out of expected-absent is a change in what the repository
  // is, not in how well it follows the practice.
  if ((before === EXPECTED_ABSENT) !== (after === EXPECTED_ABSENT))
    return "reclassified";
  const [was, is] = [meets(before, requires), meets(after, requires)];
  if (!was && is) return "fixed";
  if (was && !is) return "regressed";
  if (rank(after) < rank(before)) return "regressed";
  return was ? "unchanged" : "still-open";
}

/**
 * How a criterion changed since the prior audit, run by plugin `priorVersion`.
 * A criterion either audit left unexamined has no score to compare: it was
 * examined since, is no longer examined, or is unexamined both times.
 */
function criterionChange(
  criterion: Criterion,
  before: Score | null,
  after: Score,
  priorVersion: string,
): Change {
  if (after === NOT_EXAMINED)
    return before === null || before === NOT_EXAMINED
      ? "not-examined"
      : "no-longer-examined";
  if (before === NOT_EXAMINED) return "examined-since";
  // A criterion newer than the prior audit's plugin was not part of that
  // audit, even when its record carries a score for it backfilled later.
  if (criterion.since && compareVersions(criterion.since, priorVersion) > 0)
    return "added-by-jig";
  return before === null
    ? "new"
    : scoredChange(before, after, criterion.requires);
}

/** Whether every criterion `refs` names now meets its bar. */
function allMet(
  refs: string[],
  all: Map<string, Criterion>,
  scores: Map<string, Score>,
): boolean {
  return refs.every((r) => {
    const score = scores.get(r);
    const c = all.get(r);
    return score !== undefined && c !== undefined && meets(score, c.requires);
  });
}

/** Where a prior declined entry stands now. */
function declinedStatus(
  entry: Declined,
  all: Map<string, Criterion>,
  scores: Map<string, Score>,
  today: string,
): Comparison["declined"][number] {
  const criteriaRefs = entry.refs.filter((r) => !r.startsWith("config/"));
  // A configuration ref is settled by config-fit, not by criterion scores,
  // so an entry that names one is never resolved here.
  const namesConfig = criteriaRefs.length < entry.refs.length;
  const missing = criteriaRefs.filter((r) => !all.has(r));
  if (missing.length > 0)
    return {
      entry,
      status: "stale",
      why: `${missing.join(", ")} is no longer a criterion; decide again or drop it`,
    };
  if (
    !namesConfig &&
    criteriaRefs.length > 0 &&
    allMet(criteriaRefs, all, scores)
  )
    return {
      entry,
      status: "resolved",
      why: "every criterion it names now meets its bar; drop the entry",
    };
  if (entry.revisit_after && entry.revisit_after <= today)
    return {
      entry,
      status: "due",
      why: `revisit date ${entry.revisit_after} has passed`,
    };
  return { entry, status: "held", why: `held until: ${entry.revisit_when}` };
}

/**
 * The criterion refs of `record`'s declined entries the team still holds on
 * `today`, with the condition each waits for. Configuration refs are left to
 * config-fit, which decides whether a decline hides its finding.
 */
export function heldCriteria(
  record: AuditRecord,
  modules: readonly Module[],
  today: string,
): Map<string, string> {
  const all = new Map<string, Criterion>(
    modules.flatMap((m) => m.criteria.map((c) => [c.key, c] as const)),
  );
  const scores = scoresOf(record);
  const held = new Map<string, string>();
  for (const entry of record.declined)
    if (declinedStatus(entry, all, scores, today).status === "held")
      for (const ref of entry.refs)
        if (!ref.startsWith("config/")) held.set(ref, entry.revisit_when);
  return held;
}

/**
 * Compare a new record with the prior one. A criterion is `fixed` when it
 * now meets its bar and did not, `regressed` when it no longer meets it or
 * its rung dropped (below the bar too), `still-open` when it fails both times
 * on the same or a higher rung; one whose `since` is newer than the prior
 * audit's plugin version is `added-by-jig`, whether or not the prior record
 * scores it; any other the prior record lacks is `new`. A criterion either
 * record leaves `not-examined` is reported apart (`examined-since`,
 * `no-longer-examined`, `not-examined`), never as fixed, regressed or new.
 */
export function compare(
  prior: AuditRecord,
  current: AuditRecord,
  modules: Module[],
  schema: Schema,
  today: string,
): Comparison {
  const all = new Map<string, Criterion>(
    modules.flatMap((m) => m.criteria.map((c) => [c.key, c] as const)),
  );
  const changes: CriterionChange[] = [];
  for (const [key, criterion] of all) {
    const before = prior.criteria.get(key)?.score ?? null;
    const after = current.criteria.get(key)?.score ?? null;
    if (after === null) continue;
    const change = criterionChange(
      criterion,
      before,
      after,
      prior.plugin_version,
    );
    changes.push({ key, change, prior: before, current: after });
  }
  for (const [key, entry] of prior.criteria)
    if (!all.has(key))
      changes.push({
        key,
        change: "removed",
        prior: entry.score,
        current: null,
      });

  const currentScores = scoresOf(current);
  const declined = prior.declined.map((entry) =>
    declinedStatus(entry, all, currentScores, today),
  );

  const newFields = schema.fields
    .filter(
      (f) => f.since && compareVersions(f.since, prior.plugin_version) > 0,
    )
    .map((f) => `${f.path} (since ${f.since})`);

  const priorScores = scoresOf(prior);
  const levels = modules.map((m) => ({
    module: `${m.module} ${m.name}`,
    prior: attainedAsOf(m, prior.plugin_version, priorScores),
    current: attained(m, currentScores),
  }));
  return { criteria: changes, declined, newFields, levels };
}

const CHANGE_ORDER: Change[] = [
  "regressed",
  "fixed",
  "added-by-jig",
  "new",
  "still-open",
  "reclassified",
  "examined-since",
  "no-longer-examined",
  "removed",
];

/** A group's heading where the change's name does not read as words. */
const CHANGE_HEADING: Partial<Record<Change, string>> = {
  "examined-since": "examined since",
  "no-longer-examined": "no longer examined",
};

/** What a module attains, as a table cell says it. */
export function attainmentText(a: Attainment | null): string {
  if (a === null) return "incomplete";
  return a === NOT_EXAMINED ? "not examined" : a;
}

export function renderComparison(c: Comparison, prior: AuditRecord): string {
  const lines = [
    `# Changes since the audit of ${prior.date} (plugin ${prior.plugin_version})`,
    "",
  ];
  for (const change of CHANGE_ORDER) {
    const rows = c.criteria.filter((r) => r.change === change);
    if (rows.length === 0) continue;
    lines.push(`## ${CHANGE_HEADING[change] ?? change} (${rows.length})`, "");
    for (const r of rows)
      lines.push(`- ${r.key}: ${r.prior ?? "—"} → ${r.current ?? "—"}`);
    lines.push("");
  }
  const count = (change: Change) =>
    c.criteria.filter((r) => r.change === change).length;
  lines.push(`Unchanged and met: ${count("unchanged")}.`, "");
  if (count("not-examined") > 0)
    lines.push(`Not examined: ${count("not-examined")}.`, "");
  if (c.newFields.length > 0)
    lines.push(
      "## Configuration fields added since",
      "",
      ...c.newFields.map((f) => `- ${f}`),
      "",
    );
  if (c.declined.length > 0) {
    lines.push("## Declined recommendations", "");
    for (const d of c.declined)
      lines.push(`- **${d.status}** ${d.entry.refs.join(", ")}: ${d.why}`);
    lines.push("");
  }
  lines.push(
    "## Levels attained",
    "",
    "| Module | Prior | Now |",
    "|--------|-------|-----|",
  );
  for (const l of c.levels)
    lines.push(
      `| ${l.module} | ${attainmentText(l.prior)} | ${attainmentText(l.current)} |`,
    );
  return `${lines.join("\n")}\n`;
}

/**
 * How the evidence of a score a probe decided begins. `score.ts` writes it on
 * every `absent` its probe decided, and only there, so the sheet can tell a
 * probe's score from the agent's: an agent that scores the criterion itself
 * writes its own evidence in its place.
 */
export const PROBE_EVIDENCE = "probe: ";

/** The evidence of a score a probe decided: the search it ran, marked as the probe's. */
export const probeEvidence = (search: string): string =>
  `${PROBE_EVIDENCE}${search}`;

/** Whether a record's entry is a score its probe decided, by the mark `probeEvidence` writes. */
export function decidedByProbe(entry: Scored | undefined): boolean {
  return (
    entry?.score === "absent" &&
    (entry.evidence?.startsWith(PROBE_EVIDENCE) ?? false)
  );
}

/**
 * How the evidence of a criterion the draft left unexamined begins:
 * `score.ts --draft --profile` writes it on each criterion beyond the
 * profile's target.
 */
export const NOT_EXAMINED_EVIDENCE = "not examined: ";

/** The evidence of a criterion left unexamined beyond `profileName`'s target. */
export const notExaminedEvidence = (profileName: string): string =>
  `${NOT_EXAMINED_EVIDENCE}beyond the ${profileName} target`;

/** One YAML double-quoted scalar: JSON's string syntax is a subset of it. */
export const quote = (s: string): string => JSON.stringify(s);

const oneLine = (s: string): string => s.replace(/\s+/g, " ");

/** One criterion's draft entry: its comments, then its score and evidence. */
function draftCriterion(
  c: Criterion,
  prior: { score: Score | null; evidence: string | null } | undefined,
  decided: { score: Score; evidence: string } | undefined,
  hint: string | undefined,
  atMost: Rung | undefined,
): string[] {
  const out = [
    `  ${c.key}:   # ${c.level}, requires ${c.requires}`,
    `    # ${oneLine(c.statement)}`,
  ];
  if (prior?.score)
    out.push(`    # prior: ${prior.score}: ${oneLine(prior.evidence ?? "")}`);
  if (hint) out.push(`    # probe ${oneLine(hint)}`);
  out.push(`    score: ${decided ? decided.score : "null"}`);
  out.push(`    evidence: ${decided ? quote(decided.evidence) : "null"}`);
  if (atMost) out.push(`    at_most: ${atMost}`);
  return out;
}

/** A declined entry in the shape of the file it came from: its kept keys beside the defined ones. */
export function declinedData(d: Declined): Record<string, unknown> {
  const { other, ...defined } = d;
  return { ...defined, ...other };
}

/** One declined entry as block-list lines, its dash after `indent`. */
export function declinedEntryLines(d: Declined, indent = "  "): string[] {
  const out = [
    `${indent}- refs: [${d.refs.map(quote).join(", ")}]`,
    `${indent}  reason: ${quote(d.reason)}`,
    `${indent}  revisit_when: ${quote(d.revisit_when)}`,
  ];
  if (d.revisit_after)
    out.push(`${indent}  revisit_after: ${quote(d.revisit_after)}`);
  // JSON is YAML, so a value of any shape `parseDeclined` keeps is written
  // on one line and read back as it was.
  for (const [key, value] of Object.entries(d.other ?? {}))
    out.push(
      `${indent}  ${/^[A-Za-z_][\w-]*$/.test(key) ? key : quote(key)}: ${JSON.stringify(value)}`,
    );
  return out;
}

/** The prior record's declined entries, carried over unchanged. */
function draftDeclined(declined: Declined[]): string[] {
  if (declined.length === 0) return ["declined: []"];
  return ["declined:", ...declined.flatMap((d) => declinedEntryLines(d))];
}

/**
 * A draft record for a new audit, ready for the agent to fill in. Scores the
 * script decided (a probe whose precondition is missing, or a criterion left
 * unexamined beyond the profile's target) are filled; every
 * other criterion has `score: null` with its statement, its pass bar and the
 * prior audit's answer as comments. A criterion whose probe caps it carries
 * `at_most`, which `record.ts` holds every score to. The prior record's
 * declined entries are carried over unchanged.
 */
export function renderDraft(opts: {
  modules: Module[];
  decided: ReadonlyMap<string, { score: Score; evidence: string }>;
  hints: ReadonlyMap<string, string>;
  /** The highest rung each capped criterion's probe allows. */
  ceilings?: ReadonlyMap<string, Rung>;
  prior: AuditRecord | null;
  pluginVersion: string;
  date: string;
  commit: string;
  /** The ids a `profile:` may name, for the draft's comment. */
  profileIds?: readonly string[];
}): string {
  const out = [
    "# Jig audit record: written by /jig:audit, read by its next run.",
    "# Each criterion carries its level, pass bar and statement as comments.",
    "version: 1",
    `plugin_version: ${opts.pluginVersion}`,
    `date: ${quote(opts.date)}`,
    `commit: ${opts.commit}`,
    `shape: ${opts.prior?.shape ? quote(opts.prior.shape) : "null"}   # library | application | service | monorepo | documentation | infrastructure | …`,
    `profile: ${opts.prior?.profile ?? "null"}   # ${opts.profileIds?.join(" | ") ?? "a profile id from profiles.yaml"}: leave null unless the team chose one; a suggested profile goes in the report source`,
    ...(opts.prior?.heading_to ? [`heading_to: ${opts.prior.heading_to}`] : []),
    ...(opts.prior?.profile_conditions?.length
      ? [`profile_conditions: [${opts.prior.profile_conditions.join(", ")}]`]
      : []),
    "criteria:",
  ];
  for (const m of opts.modules) {
    out.push(`  # ${m.module} ${m.name}`);
    for (const c of m.criteria)
      out.push(
        ...draftCriterion(
          c,
          opts.prior?.criteria.get(c.key),
          opts.decided.get(c.key),
          opts.hints.get(c.key),
          opts.ceilings?.get(c.key),
        ),
      );
  }
  out.push(...draftDeclined(opts.prior?.declined ?? []));
  return `${out.join("\n")}\n`;
}

/** Scores of several repositories' records side by side. */
export function renderPortfolio(
  records: { name: string; record: AuditRecord }[],
  modules: Module[],
): string {
  const names = records.map((r) => r.name);
  const head = `| Criterion | Requires | ${names.join(" | ")} |`;
  const rule = `|-----------|----------|${names.map(() => "---").join("|")}|`;
  const lines = [
    "# Portfolio scores",
    "",
    `Records: ${records.map((r) => `${r.name} (${r.record.date}, plugin ${r.record.plugin_version}${r.record.shape ? `, ${r.record.shape}` : ""})`).join("; ")}.`,
    "A ✓ marks a criterion that meets its bar; `expected-absent` is met by the repository's shape.",
    "",
    "## Levels attained",
    "",
    `| Module | ${names.join(" | ")} |`,
    `|--------|${names.map(() => "---").join("|")}|`,
  ];
  for (const m of modules)
    lines.push(
      `| ${m.module} ${m.name} | ${records.map((r) => attainmentText(attained(m, scoresOf(r.record)))).join(" | ")} |`,
    );
  lines.push("");
  for (const m of modules) {
    lines.push(`## ${m.module} ${m.name}`, "", head, rule);
    for (const c of m.criteria) {
      const cells = records.map((r) => {
        const score = r.record.criteria.get(c.key)?.score;
        if (!score) return "—";
        return meets(score, c.requires) && score !== EXPECTED_ABSENT
          ? `${score} ✓`
          : score;
      });
      lines.push(`| ${c.id} | ${c.requires} | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Why answers cannot be written into a draft; nothing was written. */
export class DraftEditRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftEditRefused";
  }
}

/** A score and its evidence, as `fill` and `merge` write them into a draft. */
export interface Answer {
  score: Score;
  evidence: string;
}

const indentOf = (line: string): number => /^ */.exec(line)?.[0].length ?? 0;
const isContent = (line: string): boolean =>
  line.trim() !== "" && !line.trimStart().startsWith("#");
const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** The line holding `key`'s entry under `criteria:`, or -1. */
function entryLine(lines: string[], key: string): number {
  const start = lines.findIndex((l) => /^criteria:/.test(l));
  if (start < 0) return -1;
  const pattern = new RegExp(`^ +(["']?)${escapeRegExp(key)}\\1\\s*:`);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isContent(line) && indentOf(line) === 0) return -1;
    if (pattern.test(line)) return i;
  }
  return -1;
}

/**
 * Set one field (`score` or `evidence`) among an entry's lines
 * `[from, to)`, replacing its value and any lines it continues onto, or
 * adding it at the entry's end. Returns the entry's new end.
 */
function setField(
  lines: string[],
  from: number,
  to: number,
  indent: number,
  field: string,
  value: string,
): number {
  const at = lines
    .slice(from, to)
    .findIndex(
      (l) => indentOf(l) === indent && l.trimStart().startsWith(`${field}:`),
    );
  const line = `${" ".repeat(indent)}${field}: ${value}`;
  if (at < 0) {
    let end = to;
    while (end > from && !isContent(lines[end - 1] ?? "")) end--;
    lines.splice(end, 0, line);
    return to + 1;
  }
  const i = from + at;
  let next = i + 1;
  // A value written over several lines continues on deeper lines.
  for (let j = i + 1; j < to; j++) {
    const l = lines[j] ?? "";
    if (l.trim() === "") continue;
    if (indentOf(l) <= indent) break;
    next = j + 1;
  }
  lines.splice(i, next - i, line);
  return to - (next - i - 1);
}

/**
 * The draft's text with each criterion of `answers` scored, its comments and
 * everything else kept. Evidence is written as a quoted scalar, so any text
 * reads back as it was; the result is parsed again, and a criterion that does
 * not read back as answered fails the whole edit.
 */
export function setScores(
  source: string,
  answers: ReadonlyMap<string, Answer>,
  file: string,
): string {
  const lines = source.split("\n");
  const before = parseRecord(source, file);
  for (const [key, answer] of answers) {
    const i = entryLine(lines, key);
    if (i < 0)
      throw new DraftEditRefused(`${file}: ${key} has no entry under criteria`);
    setEntry(lines, i, key, answer, before.criteria.get(key)?.at_most);
  }
  const text = lines.join("\n");
  const written = parseRecord(text, file);
  const unread = [...answers].find(([key, answer]) => {
    const entry = written.criteria.get(key);
    return (
      entry?.score !== answer.score ||
      entry.evidence !== answer.evidence ||
      entry.at_most !== before.criteria.get(key)?.at_most
    );
  });
  if (unread)
    throw new DraftEditRefused(
      `${file}: ${unread[0]} does not read back as written; edit it by hand`,
    );
  return text;
}

/** Score the entry whose key stands on line `i`, in its flow or block form. */
function setEntry(
  lines: string[],
  i: number,
  key: string,
  answer: Answer,
  atMost: Rung | undefined,
) {
  const keyLine = lines[i] ?? "";
  const indent = indentOf(keyLine);
  const value = keyLine.slice(keyLine.indexOf(":", indent + key.length) + 1);
  if (value.trim().startsWith("{")) {
    lines[i] =
      `${keyLine.slice(0, keyLine.length - value.length)} { score: ${answer.score}, evidence: ${quote(answer.evidence)}${atMost ? `, at_most: ${atMost}` : ""} }`;
    return;
  }
  let end = i + 1;
  while (end < lines.length && !endsEntry(lines[end] ?? "", indent)) end++;
  const first = lines.slice(i + 1, end).find(isContent);
  const child = first === undefined ? indent + 2 : indentOf(first);
  end = setField(lines, i + 1, end, child, "score", answer.score);
  setField(lines, i + 1, end, child, "evidence", quote(answer.evidence));
}

/** Whether `line` starts what follows an entry indented by `indent`. */
const endsEntry = (line: string, indent: number): boolean =>
  isContent(line) && indentOf(line) <= indent;

/** One answer as an answers file gives it, before it is checked. */
export interface GivenAnswer {
  key: string;
  score: unknown;
  evidence: unknown;
  /** Where the answer stands, for a problem's message. */
  at: string;
}

const ANSWER_LINE = /^(\S+?)\s*:\s*(\S+)\s*\|\s*(.*)$/;

/**
 * The answers of an answers file: JSON (`{ "M1/x": { "score": …, "evidence":
 * … } }`), or one answer per line (`M1/x: mechanical | evidence text`) with
 * blank lines and `#` comments skipped. Refuses a line it cannot read.
 */
export function parseAnswers(source: string, file: string): GivenAnswer[] {
  if (source.trimStart().startsWith("{")) {
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new DraftEditRefused(
        `${file}: not valid JSON (${error instanceof Error ? error.message : error})`,
      );
    }
    if (!isRecord(raw))
      throw new DraftEditRefused(`${file}: must map criteria to answers`);
    return Object.entries(raw).map(([key, a]) => ({
      key,
      score: isRecord(a) ? a.score : undefined,
      evidence: isRecord(a) ? a.evidence : undefined,
      at: `${file}: ${key}`,
    }));
  }
  const answers: GivenAnswer[] = [];
  source.split(/\r?\n/).forEach((line, i) => {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) return;
    const m = ANSWER_LINE.exec(text);
    if (!m)
      throw new DraftEditRefused(
        `${file}:${i + 1}: write <criterion>: <score> | <evidence>`,
      );
    answers.push({
      key: m[1] ?? "",
      score: m[2],
      evidence: (m[3] ?? "").trim(),
      at: `${file}:${i + 1}`,
    });
  });
  return answers;
}

/**
 * What stops answers from being written into `draft`: a criterion this plugin
 * does not have or the draft lacks, one answered twice, a score that is not
 * one, empty evidence, a change to a score the probe decided, or a change to
 * an answer the draft already holds. The answers
 * that hold and change something are returned to write.
 */
export function checkAnswers(
  given: readonly GivenAnswer[],
  draft: AuditRecord,
  modules: readonly Module[],
): { answers: Map<string, Answer>; problems: string[] } {
  const known = new Set(modules.flatMap((m) => m.criteria.map((c) => c.key)));
  const answers = new Map<string, Answer>();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const a of given) {
    const problem = answerProblem(a, draft, known, seen);
    seen.add(a.key);
    if (problem !== null) {
      problems.push(`${a.at}: ${problem}`);
      continue;
    }
    const answer = { score: a.score as Score, evidence: a.evidence as string };
    const entry = draft.criteria.get(a.key);
    if (entry?.score !== answer.score || entry.evidence !== answer.evidence)
      answers.set(a.key, answer);
  }
  return { answers, problems };
}

/**
 * A probe's `absent` stands, except that the repository's shape may rule the
 * practice out: `expected-absent` replaces it.
 */
const PROBE_DECIDED = (key: string): string =>
  `${key}: its probe decided it (absent); leave it, or score it expected-absent where the repository's shape rules the practice out`;

/**
 * Whether `entry` already holds an agent's answer that a new one would
 * change: one scored, examined and not the probe's. Two workers answering one
 * criterion differently disagree, and the second answer must not overwrite
 * the first unseen. Null and `not-examined` entries take any answer.
 */
const answeredOtherwise = (
  entry: Scored,
  score: unknown,
  evidence: unknown,
): boolean =>
  entry.score !== null &&
  entry.score !== NOT_EXAMINED &&
  !decidedByProbe(entry) &&
  (entry.score !== score || entry.evidence !== evidence);

const ANSWERED_OTHERWISE = (key: string, entry: Scored): string =>
  `${key}: the draft already scores it ${entry.score} (${entry.evidence ?? ""}); settle the disagreement and edit the draft by hand rather than answering it again`;

/** Why one answer cannot be written, or null. */
function answerProblem(
  a: GivenAnswer,
  draft: AuditRecord,
  known: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): string | null {
  if (!known.has(a.key))
    return `${a.key} is not a criterion of this plugin version`;
  if (seen.has(a.key)) return `${a.key} is answered twice`;
  const entry = draft.criteria.get(a.key);
  if (!entry) return `${a.key} is not in the draft`;
  if (!(SCORES as readonly unknown[]).includes(a.score))
    return `${a.key}: ${String(a.score)} is not a score (${SCORES.join(" | ")})`;
  if (!text(a.evidence)) return `${a.key}: evidence is empty`;
  if (
    decidedByProbe(entry) &&
    a.score !== EXPECTED_ABSENT &&
    (a.score !== entry.score || a.evidence !== entry.evidence)
  )
    return PROBE_DECIDED(a.key);
  if (aboveCeiling(entry, a.score)) return ABOVE_CEILING(a.key, entry);
  if (answeredOtherwise(entry, a.score, a.evidence))
    return ANSWERED_OTHERWISE(a.key, entry);
  return null;
}

/**
 * The scores partial drafts add to `draft`: copies of it (same commit, date
 * and plugin version) in which a worker scored its modules. A partial that
 * is not such a copy, two partials scoring one criterion differently, a
 * change to a score the probe decided and a change to an answer the draft
 * already holds are problems; an entry a partial left
 * as the draft has it adds nothing.
 */
export function mergePartials(
  draft: AuditRecord,
  partials: readonly { path: string; record: AuditRecord }[],
): { answers: Map<string, Answer>; problems: string[] } {
  const taken = new Map<string, Answer & { from: string }>();
  const problems: string[] = [];
  for (const { path, record } of partials) {
    const stranger = notACopy(draft, record);
    if (stranger !== null) {
      problems.push(`${path}: ${stranger}`);
      continue;
    }
    for (const [key, entry] of record.criteria) {
      const problem = partialProblem(key, entry, draft, taken.get(key), path);
      if (problem !== null) problems.push(problem);
      else if (changes(entry, draft.criteria.get(key)))
        taken.set(key, {
          score: entry.score as Score,
          evidence: entry.evidence as string,
          from: path,
        });
    }
  }
  const answers = new Map<string, Answer>();
  for (const [k, { score, evidence }] of taken)
    answers.set(k, { score, evidence });
  return { answers, problems };
}

/** Why `record` is not a copy of `draft`, or null when it is. */
function notACopy(draft: AuditRecord, record: AuditRecord): string | null {
  const differs = (["commit", "date", "plugin_version"] as const).filter(
    (f) => record[f] !== draft[f],
  );
  if (differs.length === 0) return null;
  return `not a copy of the draft (its ${differs.join(", ")} differ${differs.length === 1 ? "s" : ""})`;
}

/** Whether a partial's entry scores what the draft's does not say already. */
const changes = (entry: Scored, base: Scored | undefined): boolean =>
  entry.score !== null &&
  (entry.score !== base?.score || entry.evidence !== base.evidence);

/**
 * Why a partial's entry cannot be taken, or null: the draft lacks it, it
 * changes a probe's score or an answer the draft holds, its evidence is
 * empty, or another partial
 * (`other`) scored it differently.
 */
function partialProblem(
  key: string,
  entry: Scored,
  draft: AuditRecord,
  other: (Answer & { from: string }) | undefined,
  path: string,
): string | null {
  const base = draft.criteria.get(key);
  if (!base) return `${path}: ${key} is not in the draft`;
  if (!changes(entry, base)) return null;
  if (decidedByProbe(base) && entry.score !== EXPECTED_ABSENT)
    return `${path}: ${PROBE_DECIDED(key)}`;
  if (aboveCeiling(base, entry.score))
    return `${path}: ${ABOVE_CEILING(key, base)}`;
  if (answeredOtherwise(base, entry.score, entry.evidence))
    return `${path}: ${ANSWERED_OTHERWISE(key, base)}`;
  if (!text(entry.evidence)) return `${path}: ${key}: evidence is empty`;
  if (
    !other ||
    (other.score === entry.score && other.evidence === entry.evidence)
  )
    return null;
  return `${key}: ${other.from} scores it ${other.score}, ${path} ${entry.score}${other.score === entry.score ? " with other evidence" : ""}`;
}

/** The criteria of `modules` a record has not scored yet. */
export function unscored(
  record: AuditRecord,
  modules: readonly Module[],
): string[] {
  return modules
    .flatMap((m) => m.criteria)
    .filter((c) => (record.criteria.get(c.key)?.score ?? null) === null)
    .map((c) => c.key);
}

/** A repository path a piece of evidence names, with the lines it cites. */
export interface EvidencePath {
  token: string;
  path: string;
  line?: number;
  end?: number;
}

/** Extensions that make a bare file name, one without a folder, read as a path. */
const FILE_EXTENSION =
  /\.(md|mdx|txt|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|json5|ya?ml|toml|ini|cfg|conf|sh|bash|zsh|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|lock|xml|html|css|scss|sql|tf|gradle|properties|nix)$/i;
/** File names without an extension that are still recognisably files. */
const BARE_FILES = new Set([
  "Makefile",
  "Dockerfile",
  "Justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Taskfile",
  "LICENSE",
  "CODEOWNERS",
]);
/** A host name, which starts a web address written without its scheme. */
const HOST = /^[\w-]+(\.[\w-]+)*\.(com|org|net|io|dev|app|sh|co|ai|so|me)$/i;
const TOKEN = /^([\w.+@-]+(?:\/[\w.+@-]+)*)(\/?)(?::(\d+)(?:-(\d+))?)?$/;

/**
 * The repository paths a piece of evidence names: `path`, `path:line` or
 * `path:line-line`. Only what reads unmistakably as a path counts (a name with
 * a folder and an extension, a dotfile, a known file name), so prose, globs,
 * web addresses, host queries and criterion keys are left alone.
 */
export function evidencePaths(evidence: string): EvidencePath[] {
  const found: EvidencePath[] = [];
  // A path named after a negation ("no lefthook.yml") is named as missing.
  for (const clause of evidence.split(/;|\.\s|\n/)) {
    const words = clause.split(/[\s,|()<>[\]{}"'`]+/);
    const negation = words.findIndex((w) => NEGATION.test(w));
    for (const raw of negation < 0 ? words : words.slice(0, negation)) {
      const path = evidencePath(raw);
      if (path) found.push(path);
    }
  }
  return found;
}

/** Words after which a clause names what is missing. */
const NEGATION =
  /^(no|not|none|never|without|absent|missing|lacks?|neither|nor)$/i;

/** The path one word of evidence names, or null. */
function evidencePath(raw: string): EvidencePath | null {
  if (raw.includes("://") || /[*?$~=]/.test(raw)) return null;
  const token = raw
    .replace(/#.*$/, "")
    .replace(/[.:!?]+$/, "")
    .replace(/^@/, "")
    .replace(/^\.\//, "");
  const m = TOKEN.exec(token);
  const path = m?.[1] ?? "";
  if (!m || !readsAsPath(path.split("/"), m[2] === "/")) return null;
  return {
    token,
    path,
    ...(m[3] === undefined ? {} : { line: Number(m[3]) }),
    ...(m[4] === undefined ? {} : { end: Number(m[4]) }),
  };
}

/** Whether a word's segments name something other than a path. */
function readsAsOther(segments: readonly string[]): boolean {
  const [first = "", ...rest] = segments;
  if (segments.some((s) => s === "." || s === "..")) return true;
  if (/^[\d.]+$/.test(segments.join("."))) return true;
  if (rest.length > 0) return HOST.test(first);
  // `.ts` names a kind of file, not a file.
  return /^\.[A-Za-z0-9]+$/.test(first) && FILE_EXTENSION.test(first);
}

/**
 * Whether a word's segments read unmistakably as a path: a dotfile, a known
 * file name, a folder (written with its trailing slash) or a file in one with
 * an extension, or a bare name with a known extension.
 */
function readsAsPath(segments: readonly string[], folder: boolean): boolean {
  if (readsAsOther(segments)) return false;
  const last = segments.at(-1) ?? "";
  if (/^\.[A-Za-z]/.test(segments[0] ?? "") || BARE_FILES.has(last))
    return true;
  if (segments.length > 1)
    return folder || /[^.]\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(last);
  // A library's name (Node.js) reads like a file; a file's rarely starts so.
  return FILE_EXTENSION.test(last) && !/^[A-Z][a-z]+\.js$/.test(last);
}

/**
 * The one entry of `paths` that `path` names: itself, or the entry it ends
 * (evidence often names `ci.yml` for `.github/workflows/ci.yml`). Null when
 * it ends several, undefined when none.
 */
function resolvePath(
  path: string,
  paths: ReadonlySet<string>,
): string | null | undefined {
  if (paths.has(path)) return path;
  const tail = `/${path}`;
  const ends = [...paths].filter((p) => p.endsWith(tail));
  return ends.length === 0 ? undefined : ends.length === 1 ? ends[0] : null;
}

/** The lines a file holds: the last one counts though it lacks a newline. */
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * Evidence naming a path the record's commit does not hold, or a line past
 * its file's end, read from the repository at `root`. A name the evidence
 * shortens (`ci.yml`, `scripts/gates.ts` within a package) counts when one
 * path ends with it. A probe's evidence and
 * an unexamined criterion's are the script's own and are not read. Warnings
 * only: a path may be named for what is missing.
 */
export function evidenceWarnings(record: AuditRecord, root: string): string[] {
  const tree = commitTree(root, record.commit);
  if (tree === null) return [];
  const warnings: string[] = [];
  for (const [key, entry] of record.criteria) {
    const evidence = entry.evidence ?? "";
    if (
      evidence.startsWith(PROBE_EVIDENCE) ||
      evidence.startsWith(NOT_EXAMINED_EVIDENCE)
    )
      continue;
    const cited = new Map(evidencePaths(evidence).map((p) => [p.token, p]));
    for (const p of cited.values()) {
      const warning = p.path === RECORD_RELPATH ? null : pathWarning(p, tree);
      if (warning !== null) warnings.push(`${key}: ${warning}`);
    }
  }
  return warnings;
}

/** The files and folders a commit holds, and a file's line count there. */
interface CommitTree {
  short: string;
  files: ReadonlySet<string>;
  folders: ReadonlySet<string>;
  linesOf: (file: string) => number | null;
}

/** What `commit` holds in the repository at `root`, or null when unreadable. */
function commitTree(root: string, commit: string): CommitTree | null {
  const tree = run("git", ["ls-tree", "-r", "--name-only", "-z", commit], {
    cwd: root,
  });
  if (tree.code !== 0) return null;
  const files = new Set(tree.stdout.split("\0").filter(Boolean));
  const folders = new Set(
    [...files].flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  const lines = new Map<string, number | null>();
  const linesOf = (file: string): number | null => {
    if (!lines.has(file)) {
      const blob = run("git", ["cat-file", "blob", `${commit}:${file}`], {
        cwd: root,
      });
      lines.set(file, blob.code === 0 ? lineCount(blob.stdout) : null);
    }
    return lines.get(file) ?? null;
  };
  return { short: commit.slice(0, 12), files, folders, linesOf };
}

/** What is wrong with one cited path at the commit, or null. */
function pathWarning(p: EvidencePath, tree: CommitTree): string | null {
  const file = resolvePath(p.path, tree.files);
  if (file === undefined && resolvePath(p.path, tree.folders) === undefined)
    return `${p.token} is not in commit ${tree.short}`;
  const last = p.end ?? p.line;
  if (last === undefined || typeof file !== "string") return null;
  const count = tree.linesOf(file);
  return count !== null && last > count
    ? `${p.token} cites a line past the end of ${file} (${count} lines at ${tree.short})`
    : null;
}

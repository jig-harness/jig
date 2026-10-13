/**
 * The audit record (`.config/jig-audit.yaml`): what an audit found, committed
 * in the audited repository so the next audit can compare against it.
 *
 *   version: 1
 *   plugin_version: 0.13.0     # the plugin that ran the audit
 *   date: 2026-10-12
 *   commit: <full sha>          # the commit audited
 *   shape: library              # what the repository is; calibrates expected-absent
 *   profile: team-standard      # optional: the profile the team aims for (profiles.yaml)
 *   profile_conditions: [M12]   # optional: the conditional targets that apply
 *   heading_to: regulated-strict  # optional: the profile the project is growing toward
 *   criteria:
 *     M1/ci-runs-gates-on-pr:
 *       score: mechanical       # absent | convention | advisory | mechanical | expected-absent
 *       evidence: .github/workflows/ci.yml runs the gates; required on main
 *   declined:                   # recommendations the team chose not to take
 *     - refs: [M1/precommit-autofix-hooks]
 *       reason: The editor formats on save and CI checks formatting.
 *       revisit_when: Formatting failures reach CI more than once a month.
 *       revisit_after: 2027-04-01   # optional: raise it again after this date
 *
 * A declined entry's `refs` name criteria (`M<n>/<id>`) or configuration
 * findings (`config/<finding id>`).
 */
import { isMapping as isRecord } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import type { Profiles } from "./profiles.ts";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";
import {
  type Attainment,
  attained,
  type Criterion,
  EXPECTED_ABSENT,
  meets,
  type Module,
  rank,
  type Score,
  SCORES,
} from "./criteria.ts";
import type { Schema } from "./schema.ts";
import { compareVersions, isDate, VERSION_PATTERN } from "./repo.ts";

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
  criteria: Map<string, { score: Score | null; evidence: string | null }>;
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

type Scored = { score: Score | null; evidence: string | null };

function parseCriteria(raw: unknown, file: string): Map<string, Scored> {
  if (!isRecord(raw)) throw new Error(`${file}: criteria must be a mapping`);
  const criteria = new Map<string, Scored>();
  for (const [key, entry] of Object.entries(raw)) {
    if (!/^M\d+\/[a-z0-9-]+$/.test(key))
      throw new Error(`${file}: ${key} is not a criterion key (M<n>/<id>)`);
    if (!isRecord(entry)) throw new Error(`${file}: ${key} must be a mapping`);
    const score = entry.score ?? null;
    if (score !== null && !(SCORES as readonly unknown[]).includes(score))
      throw new Error(`${file}: ${key}.score must be ${SCORES.join(" | ")}`);
    const evidence = entry.evidence ?? null;
    if (evidence !== null && typeof evidence !== "string")
      throw new Error(`${file}: ${key}.evidence must be text`);
    criteria.set(key, { score: score as Score | null, evidence });
  }
  return criteria;
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
    ...[...record.criteria.keys()]
      .filter((key) => !known.has(key))
      .map((key) => `${key}: not a criterion of this plugin version`),
    ...record.declined
      .flatMap((d) => d.refs)
      .filter((ref) => ref.startsWith("M") && !known.has(ref))
      .map((ref) => `declined ${ref}: not a criterion of this plugin version`),
  ];
}

/** What is missing from one criterion's entry in the record. */
function entryProblems(key: string, record: AuditRecord): string[] {
  const entry = record.criteria.get(key);
  if (!entry) return [`${key}: missing`];
  if (entry.score === null) return [`${key}: not scored`];
  if (!text(entry.evidence)) return [`${key}: no evidence`];
  return [];
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

/** How a criterion changed since the prior audit, run by plugin `priorVersion`. */
function criterionChange(
  criterion: Criterion,
  before: Score | null,
  after: Score,
  priorVersion: string,
): Change {
  if (before !== null) return scoredChange(before, after, criterion.requires);
  return criterion.since && compareVersions(criterion.since, priorVersion) > 0
    ? "added-by-jig"
    : "new";
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
 * on the same or a higher rung; one the prior
 * record lacks is `added-by-jig` when its `since` is newer than the prior
 * audit's plugin version, else `new`.
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
    prior: attained(m, priorScores),
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
  "removed",
];

export function renderComparison(c: Comparison, prior: AuditRecord): string {
  const lines = [
    `# Changes since the audit of ${prior.date} (plugin ${prior.plugin_version})`,
    "",
  ];
  for (const change of CHANGE_ORDER) {
    const rows = c.criteria.filter((r) => r.change === change);
    if (rows.length === 0) continue;
    lines.push(`## ${change} (${rows.length})`, "");
    for (const r of rows)
      lines.push(`- ${r.key}: ${r.prior ?? "—"} → ${r.current ?? "—"}`);
    lines.push("");
  }
  const unchanged = c.criteria.filter((r) => r.change === "unchanged").length;
  lines.push(`Unchanged and met: ${unchanged}.`, "");
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
      `| ${l.module} | ${l.prior ?? "incomplete"} | ${l.current ?? "incomplete"} |`,
    );
  return `${lines.join("\n")}\n`;
}

/** One YAML double-quoted scalar: JSON's string syntax is a subset of it. */
export const quote = (s: string): string => JSON.stringify(s);

const oneLine = (s: string): string => s.replace(/\s+/g, " ");

/** One criterion's draft entry: its comments, then its score and evidence. */
function draftCriterion(
  c: Criterion,
  prior: { score: Score | null; evidence: string | null } | undefined,
  decided: { score: Score; evidence: string } | undefined,
  hint: string | undefined,
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
 * script decided (a probe whose precondition is missing) are filled; every
 * other criterion has `score: null` with its statement, its pass bar and the
 * prior audit's answer as comments. The prior record's declined entries are
 * carried over unchanged.
 */
export function renderDraft(opts: {
  modules: Module[];
  decided: ReadonlyMap<string, { score: Score; evidence: string }>;
  hints: ReadonlyMap<string, string>;
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
    `shape: ${opts.prior?.shape ? quote(opts.prior.shape) : "null"}   # library | application | service | monorepo | documentation | …`,
    `profile: ${opts.prior?.profile ?? "null"}   # ${opts.profileIds?.join(" | ") ?? "a profile id from profiles.yaml"}; null when the team has not chosen`,
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
      `| ${m.module} ${m.name} | ${records.map((r) => attained(m, scoresOf(r.record)) ?? "incomplete").join(" | ")} |`,
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

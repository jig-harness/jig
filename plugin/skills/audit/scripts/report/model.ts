/**
 * What the audit sheet and its Markdown copy show, derived once from the
 * report source, the record, the configuration-fit report and the prior
 * record: the profile and its targets, one row per module of the maturity
 * map, the counts, when each recommendation is due, the ranking, the
 * recommendations grouped by module, the gaps no recommendation covers, the
 * comparison with the prior audit and the trend across older records. Both
 * projections read this, so they cannot disagree.
 *
 * The profile is the team's dial. A recommendation is for now only when the
 * profile asks for what it moves; one the profile the project is heading to
 * asks for waits until the project grows; anything beyond both is optional.
 * The sheet never presents a practice beyond the target as a shortfall.
 *
 * `inputProblems` is the check `validate` and `render` run before any of it:
 * every recommendation names criteria the record scored or configuration
 * findings the fit report holds, none repeats a decline the team holds, the
 * profile agrees with the record, and no record of the trend is newer than
 * the audited one.
 */
import {
  type Attainment,
  attainedAsOf,
  type Criterion,
  EXPECTED_ABSENT,
  LEVELS,
  type Level,
  meets,
  type Module,
  type Score,
} from "../lib/criteria.ts";
import { gaps, type Profiles, targetsFor } from "../lib/profiles.ts";
import {
  type AuditRecord,
  type Comparison,
  type CriterionChange,
  checkRecord,
  compare,
  decidedByProbe,
  scoresOf,
} from "../lib/record.ts";
import type { Schema } from "../lib/schema.ts";
import { LABEL, plural } from "./labels.ts";
import {
  CONFIG_REF,
  type Fit,
  type ProfileSignal,
  type ProfileSource,
  type Recommendation,
  type ReportSource,
} from "./source.ts";

/** Everything a sheet is rendered from. */
export interface ReportInput {
  source: ReportSource;
  record: AuditRecord;
  fit: Fit | null;
  prior: AuditRecord | null;
  /** Older records of the same repository, for the trend; in any order. */
  history: AuditRecord[];
  modules: Module[];
  profiles: Profiles;
  schema: Schema;
  /** The day the declined recommendations are judged on, YYYY-MM-DD. */
  today: string;
}

// ---------- the checks ----------

/** Whether `ref` names a configuration finding the fit report rates an error. */
function configError(ref: string, fit: Fit | null): boolean {
  const id = ref.slice("config/".length);
  return (
    CONFIG_REF.test(ref) &&
    (fit?.findings.some((f) => f.id === id && f.severity === "error") ?? false)
  );
}

/**
 * The refs of the record's declined entries the team still holds, as
 * `compare` judges them, with the condition each waits for. A configuration
 * error is never held: no decline hides it, as in `config-fit.ts`.
 */
function heldRefs(input: ReportInput): Map<string, string> {
  const { record, modules, schema, today, fit } = input;
  const held = new Map<string, string>();
  for (const d of compare(record, record, modules, schema, today).declined)
    if (d.status === "held")
      for (const ref of d.entry.refs)
        if (!configError(ref, fit)) held.set(ref, d.entry.revisit_when);
  return held;
}

function refProblem(
  ref: string,
  at: string,
  record: AuditRecord,
  fit: Fit | null,
): string | null {
  if (CONFIG_REF.test(ref)) {
    const id = ref.slice("config/".length);
    return fit && !fit.findings.some((f) => f.id === id)
      ? `${at}: ${ref} is not a finding of the configuration-fit report`
      : null;
  }
  return record.criteria.has(ref)
    ? null
    : `${at}: ${ref} is not a criterion the record scored`;
}

function recommendationProblems(input: ReportInput): string[] {
  const held = heldRefs(input);
  return input.source.recommendations.flatMap((r, i) => {
    const at = `$.recommendations[${i}] (${r.id})`;
    const problems = r.refs
      .map((ref) => refProblem(ref, `${at}.refs`, input.record, input.fit))
      .filter((p): p is string => p !== null);
    // A recommendation that bundles held work with other work would still ask
    // for the held part, so any held ref refuses it.
    for (const ref of r.refs.filter((ref) => held.has(ref)))
      problems.push(
        `${at}: the team declined ${ref} and holds it until: ${held.get(ref)}; leave it out of the report`,
      );
    return problems;
  });
}

const profileIds = (input: ReportInput) =>
  [...input.profiles.profiles.keys()].join(", ");

/** The source's profile agrees with the record's; the record's own are checked with it. */
function profileProblems(input: ReportInput): string[] {
  const problems: string[] = [];
  const p = input.source.profile;
  if (!p) return problems;
  const declared = input.record.profile;
  if (!input.profiles.profiles.has(p.id))
    problems.push(`$.profile.id: ${p.id} is not one of ${profileIds(input)}`);
  if (p.source === "declared" && declared !== p.id)
    problems.push(
      `$.profile: a declared profile is the record's, and the record's is ${declared ?? "not set"}`,
    );
  if (p.source === "suggested" && declared !== undefined)
    problems.push(
      `$.profile: the record declares ${declared}; suggest a profile only when the team has none`,
    );
  return problems;
}

const recordAt = (r: AuditRecord) => `${r.date} (${r.commit.slice(0, 7)})`;

/**
 * The trend runs from the past to now: the prior record is the latest before
 * the audited one, each history record comes before both, and no two history
 * records share a day, since a date alone cannot order them.
 */
function historyProblems(input: ReportInput): string[] {
  const { prior, record } = input;
  return [
    ...(prior && prior.date > record.date
      ? [
          `prior: the record of ${recordAt(prior)} is newer than the audited record of ${record.date}; give the last audit before it`,
        ]
      : []),
    ...input.history.flatMap((h) => newerHistory(h, record, prior)),
    ...sameDay(pastRecords(input).filter((r) => r !== prior)),
  ];
}

/** A history record dated after the audited record, or after the prior one. */
function newerHistory(
  h: AuditRecord,
  record: AuditRecord,
  prior: AuditRecord | null,
): string[] {
  if (h.date > record.date)
    return [
      `history: the record of ${recordAt(h)} is newer than the audited record of ${record.date}; give only older records`,
    ];
  if (prior && h.date > prior.date)
    return [
      `history: the record of ${recordAt(h)} is newer than the prior record of ${prior.date}; give the latest as --prior and only older records as history`,
    ];
  return [];
}

/** Neighbours of the date-sorted `records` that share a date. */
function sameDay(records: readonly AuditRecord[]): string[] {
  return records.flatMap((r, i) => {
    const next = records[i + 1];
    return next && next.date === r.date
      ? [
          `history: the records ${recordAt(r)} and ${recordAt(next)} share a date, so the trend cannot order them; give one of them`,
        ]
      : [];
  });
}

/** Everything that keeps the source from being rendered against this record and fit report. */
export function inputProblems(input: ReportInput): string[] {
  return [
    ...checkRecord(input.record, input.modules, input.profiles).map(
      (p) => `record: ${p}`,
    ),
    ...profileProblems(input),
    ...recommendationProblems(input),
    ...historyProblems(input),
  ];
}

// ---------- the profile and its targets ----------

export interface ProfileView {
  id: string;
  name: string;
  source: ProfileSource;
  why?: string;
  /** Facts suggesting the team revisit the profile; never a finding. */
  signals: ProfileSignal[];
}

/** The record's profile, declared; else the one the source suggests; else none. */
export function profileOf(input: ReportInput): ProfileView | null {
  const id = input.record.profile ?? input.source.profile?.id;
  const profile =
    id === undefined ? undefined : input.profiles.profiles.get(id);
  if (!profile) return null;
  const why = input.source.profile?.why;
  return {
    id: profile.id,
    name: profile.name,
    source: input.record.profile ? "declared" : "suggested",
    ...(why ? { why } : {}),
    signals: input.source.profile?.signals ?? [],
  };
}

/**
 * The levels the sheet measures against: the profile's targets now, and the
 * targets of the profile the project is heading to, when the record names
 * one. The team's conditional targets apply to both.
 */
export interface Targets {
  profile: ProfileView | null;
  now: ReadonlyMap<string, Level> | null;
  heading: { id: string; name: string } | null;
  grow: ReadonlyMap<string, Level> | null;
}

export function targetsOf(input: ReportInput): Targets {
  const { record, profiles } = input;
  const view = profileOf(input);
  const profile = view ? profiles.profiles.get(view.id) : undefined;
  const conditions =
    view?.source === "declared" ? (record.profile_conditions ?? []) : [];
  const heading = record.heading_to
    ? profiles.profiles.get(record.heading_to)
    : undefined;
  return {
    profile: view,
    now: profile ? targetsFor(profile, conditions) : null,
    heading: heading ? { id: heading.id, name: heading.name } : null,
    grow: heading ? targetsFor(heading, record.profile_conditions) : null,
  };
}

/** Whether a criterion lies at or below its module's level in `targets`. */
function within(
  c: Criterion,
  module: string,
  targets: ReadonlyMap<string, Level> | null,
): boolean {
  const level = targets?.get(module);
  return (
    level !== undefined && LEVELS.indexOf(c.level) <= LEVELS.indexOf(level)
  );
}

// ---------- the map ----------

/** Words of a module's file name, with the acronyms in capitals. */
const ACRONYMS = new Set(["adr", "pr"]);

export function moduleTitle(m: Module): string {
  const words = m.name
    .split("-")
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w));
  const text = words.join(" ");
  return `${m.module} ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

export type DecidedBy = "probe" | "agent";

export interface Cell {
  criterion: Criterion;
  score: Score | null;
  evidence: string | null;
  decidedBy: DecidedBy;
  /** Within the profile's target; null without a profile. */
  inTarget: boolean | null;
  /** Within the target and not meeting its bar yet: the only cells the sheet marks as a gap. */
  gap: boolean;
  /** A gap no recommendation moves and no held decline leaves deliberately. */
  uncovered: boolean;
}

export interface ModuleRow {
  module: Module;
  title: string;
  attained: Attainment | null;
  /** The profile's target, or null without one or for a module that does not apply. */
  target: Level | null;
  /** The heading-to profile's target, where it asks for more than today's. */
  heading: Level | null;
  /** Criteria at or below the target that do not meet their bar yet. */
  missing: number;
  cells: Cell[];
  /** Why the module does not apply, when every criterion is expected-absent. */
  naReason?: string;
}

/**
 * The criteria the report accounts for: those a recommendation moves, and
 * those the team declined and still holds, which it leaves deliberately.
 */
function accountedFor(input: ReportInput): Set<string> {
  return new Set([
    ...input.source.recommendations.flatMap((r) => r.refs),
    ...heldRefs(input).keys(),
  ]);
}

/**
 * A probe decides a criterion only by finding its precondition missing, and
 * `score.ts` marks the evidence of that `absent` (`decidedByProbe`); every
 * other score, including an `absent` the agent wrote over a probe's hint, is
 * the agent's.
 */
function cellOf(
  c: Criterion,
  module: string,
  input: ReportInput,
  targets: Targets,
  accounted: ReadonlySet<string>,
): Cell {
  const entry = input.record.criteria.get(c.key);
  const score = entry?.score ?? null;
  const inTarget = targets.now ? within(c, module, targets.now) : null;
  const gap =
    inTarget === true && (score === null || !meets(score, c.requires));
  return {
    criterion: c,
    score,
    evidence: entry?.evidence ?? null,
    decidedBy: decidedByProbe(entry) ? "probe" : "agent",
    inTarget,
    gap,
    uncovered: gap && !accounted.has(c.key),
  };
}

/** The heading-to level, only where it reaches beyond today's target. */
function headingLevel(
  module: string,
  target: Level | null,
  targets: Targets,
): Level | null {
  const level = targets.grow?.get(module) ?? null;
  if (level === null) return null;
  return target === null || LEVELS.indexOf(level) > LEVELS.indexOf(target)
    ? level
    : null;
}

/** One row per module, in adoption order. */
export function mapRows(input: ReportInput, targets: Targets): ModuleRow[] {
  const { record, modules, profiles } = input;
  const rows = gaps(
    modules,
    scoresOf(record),
    targets.now ?? new Map(),
    profiles.order,
  );
  const accounted = accountedFor(input);
  return rows.map((g) => {
    const id = g.module.module;
    const cells = g.module.criteria.map((c) =>
      cellOf(c, id, input, targets, accounted),
    );
    const na = g.attained === "n/a";
    return {
      module: g.module,
      title: moduleTitle(g.module),
      attained: g.attained,
      target: g.target,
      heading: na ? null : headingLevel(id, g.target, targets),
      missing: g.missing.length,
      cells,
      ...(na
        ? {
            naReason: cells[0]?.evidence ?? LABEL.rungMeaning[EXPECTED_ABSENT],
          }
        : {}),
    };
  });
}

const TALLY_ORDER: readonly (Score | null)[] = [
  "mechanical",
  "advisory",
  "convention",
  "absent",
  EXPECTED_ABSENT,
  null,
];

/** The gaps no recommendation covers, in the map's order. */
export function uncoveredGaps(rows: readonly ModuleRow[]): Cell[] {
  return rows.flatMap((r) => r.cells.filter((c) => c.uncovered));
}

/** How many of a module's criteria sit on each rung, strongest first; a rung with none is left out. */
export function tally(row: ModuleRow): { score: Score | null; n: number }[] {
  return TALLY_ORDER.map((score) => ({
    score,
    n: row.cells.filter((c) => c.score === score).length,
  })).filter((t) => t.n > 0);
}

// ---------- when a recommendation is due ----------

/** Now, as the project grows toward its heading-to profile, or optional for this profile. */
export type Horizon = "now" | "grow" | "optional";

/** The module a recommendation belongs to: its first criterion's, or the configuration. */
const groupOf = (r: Recommendation): string =>
  r.refs.find((ref) => !CONFIG_REF.test(ref))?.split("/")[0] ?? "config";

/**
 * A recommendation is for now when the profile asks for something it moves
 * (a criterion within the target, or any configuration finding), for later
 * when only the heading-to profile does, and optional beyond both. A
 * criterion scored expected-absent is asked for by neither: the map takes
 * the target off a module that does not apply. Without a profile there is
 * nothing to measure against, so everything is for now.
 */
export function horizonOf(
  r: Recommendation,
  input: ReportInput,
  targets: Targets,
): Horizon {
  if (!targets.now) return "now";
  const criteria = new Map(
    input.modules.flatMap((m) =>
      m.criteria.map((c) => [c.key, { c, module: m.module }] as const),
    ),
  );
  const asks = (t: ReadonlyMap<string, Level> | null) =>
    r.refs.some((ref) => {
      if (CONFIG_REF.test(ref)) return true;
      const hit = criteria.get(ref);
      return (
        hit !== undefined &&
        input.record.criteria.get(ref)?.score !== EXPECTED_ABSENT &&
        within(hit.c, hit.module, t)
      );
    });
  if (asks(targets.now)) return "now";
  return asks(targets.grow) ? "grow" : "optional";
}

/** The recommendations of one horizon, in the report's order. */
export function recsFor(
  horizon: Horizon,
  input: ReportInput,
  targets: Targets,
): Recommendation[] {
  return input.source.recommendations.filter(
    (r) => horizonOf(r, input, targets) === horizon,
  );
}

/**
 * When a recommendation beyond the profile would be worth taking: the
 * profile's own condition for its module (a conditional target the team has
 * not said holds), or null.
 */
export function worthWhen(
  r: Recommendation,
  input: ReportInput,
  targets: Targets,
): string | null {
  const profile = targets.profile
    ? input.profiles.profiles.get(targets.profile.id)
    : undefined;
  return profile?.conditional.get(groupOf(r))?.when ?? null;
}

export interface Counts {
  met: number;
  /** Criteria the repository's shape does not rule out. */
  applicable: number;
  expectedAbsent: number;
  /** Recommendations for now, and those for later or optional. */
  now: number;
  later: number;
  quickWins: number;
  /** Modules with a target, and how many of them reach it. */
  withTarget: number;
  atTarget: number;
  /** Gaps within the target no recommendation covers. */
  uncovered: number;
}

export function countsOf(
  input: ReportInput,
  rows: ModuleRow[],
  targets: Targets,
): Counts {
  const cells = rows.flatMap((r) => r.cells);
  const expectedAbsent = cells.filter(
    (c) => c.score === EXPECTED_ABSENT,
  ).length;
  const targeted = rows.filter((r) => r.target !== null);
  const now = recsFor("now", input, targets);
  return {
    met: cells.filter(
      (c) =>
        c.score !== null &&
        c.score !== EXPECTED_ABSENT &&
        meets(c.score, c.criterion.requires),
    ).length,
    applicable: cells.length - expectedAbsent,
    expectedAbsent,
    now: now.length,
    later: input.source.recommendations.length - now.length,
    quickWins: now.filter((r) => r.quick_win).length,
    withTarget: targeted.length,
    atTarget: targeted.filter((r) => r.missing === 0).length,
    uncovered: uncoveredGaps(rows).length,
  };
}

// ---------- ranking and grouping ----------

const LEVERAGE_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const EFFORT_WEIGHT = { small: 3, medium: 2, large: 1 } as const;

type Ranked = Pick<Recommendation, "leverage" | "effort" | "quick_win">;

/** Leverage × effort, high leverage for small effort first, then a quick win. */
function byValue(a: Ranked, b: Ranked): number {
  const value = (r: Ranked) =>
    LEVERAGE_WEIGHT[r.leverage] * EFFORT_WEIGHT[r.effort];
  return (
    value(b) - value(a) ||
    Number(b.quick_win ?? false) - Number(a.quick_win ?? false)
  );
}

/**
 * Ranked by `byValue`; the report's own order breaks a tie. The sheet's Start
 * here and `record.ts apply-feedback`'s work list both rank with it, so the
 * work list follows the order the team read.
 */
export function ranked<R extends Ranked>(recs: readonly R[]): R[] {
  return recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => byValue(a.r, b.r) || a.i - b.i)
    .map((x) => x.r);
}

/** The three moves that matter most now, and the quick wins beyond them. */
export function startHere(
  input: ReportInput,
  targets: Targets,
): { top: Recommendation[]; quick: Recommendation[] } {
  const now = recsFor("now", input, targets);
  const top = ranked(now).slice(0, 3);
  const quick = now.filter((r) => r.quick_win && !top.includes(r));
  return { top, quick };
}

export interface Group {
  /** `config`, or a module (`M1`). */
  id: string;
  title: string;
  purpose: string;
  recs: Recommendation[];
}

/**
 * Recommendations by module in adoption order, configuration fixes first.
 * Within a group, leverage × effort.
 */
export function groups(
  input: ReportInput,
  recs: readonly Recommendation[],
): Group[] {
  const byId = new Map(input.modules.map((m) => [m.module, m]));
  const order = ["config", ...input.profiles.order];
  return order.flatMap((id) => {
    const own = ranked(recs.filter((r) => groupOf(r) === id));
    if (own.length === 0) return [];
    const m = byId.get(id);
    return [
      m
        ? { id, title: moduleTitle(m), purpose: m.purpose, recs: own }
        : {
            id,
            title: LABEL.configGroup,
            purpose: LABEL.configPurpose,
            recs: own,
          },
    ];
  });
}

/** The current score of each criterion a recommendation moves; configuration refs have none. */
export function movedCriteria(
  r: Recommendation,
  record: AuditRecord,
): { ref: string; score: Score | null }[] {
  return r.refs.map((ref) => ({
    ref,
    score: record.criteria.get(ref)?.score ?? null,
  }));
}

// ---------- re-audits ----------

/** The comparison with the prior audit, or null on a first audit. */
export function sinceLast(input: ReportInput): Comparison | null {
  return input.prior
    ? compare(
        input.prior,
        input.record,
        input.modules,
        input.schema,
        input.today,
      )
    : null;
}

/** The changes a re-audit leads with, in reading order: a regression is what a re-audit exists to catch. */
export const SHOWN_CHANGES = [
  "regressed",
  "fixed",
  "new",
  "added-by-jig",
  "reclassified",
  "removed",
] as const;

/**
 * The criteria still open since the prior audit, split by the profile: those
 * within its target, which the team aims to close, and those beyond it,
 * which the profile does not ask for. Null without a profile.
 */
export interface StillOpen {
  profile: string;
  within: CriterionChange[];
  beyond: CriterionChange[];
}

export function stillOpenOf(
  c: Comparison,
  rows: readonly ModuleRow[],
  targets: Targets,
): StillOpen | null {
  if (!targets.profile || !targets.now) return null;
  const inTarget = new Map(
    rows.flatMap((r) =>
      r.cells.map((cell) => [cell.criterion.key, cell.inTarget]),
    ),
  );
  const open = c.criteria.filter((r) => r.change === "still-open");
  return {
    profile: targets.profile.name,
    within: open.filter((r) => inTarget.get(r.key) === true),
    beyond: open.filter((r) => inTarget.get(r.key) !== true),
  };
}

/**
 * The opening line of the comparison: the prior audit, and how many criteria
 * stayed open (within the profile's target and beyond it, when there is one)
 * or stayed met.
 */
export function sinceIntro(
  prior: AuditRecord | null,
  c: Comparison,
  open: StillOpen | null,
): string {
  const count = (change: string) =>
    c.criteria.filter((r) => r.change === change).length;
  const stillOpen = open
    ? `${open.within.length} ${LABEL.stillOpenWithin.replace("{profile}", open.profile)}; ${open.beyond.length} ${LABEL.stillOpenBeyond};`
    : `${count("still-open")} ${LABEL.stillOpen},`;
  return `${LABEL.sinceIntro} ${prior?.date ?? ""} (${LABEL.pluginWord} ${prior?.plugin_version ?? ""}): ${stillOpen} ${count("unchanged")} ${LABEL.unchangedMet}.`;
}

/** Modules whose level differs from the prior audit's; `compare` lists the levels in module order. */
export function levelChanges(
  c: Comparison,
  modules: readonly Module[],
): {
  id: string;
  module: string;
  prior: string;
  current: string;
  move: Move;
}[] {
  return c.levels.flatMap((l, i) => {
    const m = modules[i];
    return l.prior === l.current || !m
      ? []
      : [
          {
            id: m.module,
            module: moduleTitle(m),
            prior: attainedWord(l.prior),
            current: attainedWord(l.current),
            move: moveOf(l.prior, l.current),
          },
        ];
  });
}

// ---------- the trend across past records ----------

/** One record of the trend; `current` is the audit this sheet shows. */
export interface TrendPoint {
  date: string;
  commit: string;
  current: boolean;
}

/** Whether a level is higher or lower than the one before it; null where either is not a level. */
export type Move = "up" | "down" | null;

export interface TrendRow {
  /** The module's id (`M2`) and its title. */
  id: string;
  module: string;
  levels: { word: string; move: Move }[];
}

export interface Trend {
  points: TrendPoint[];
  /** Only the modules whose level changed at least once. */
  rows: TrendRow[];
  /** Modules higher, and lower, now than at the oldest record. */
  up: number;
  down: number;
  /** Modules that now stand otherwise than at the oldest record without a level up or down: n/a or incomplete at either end. */
  other: number;
  since: string;
}

/**
 * Whether two records are one audit: the same assessment, made on the same
 * day of the same commit with every score alike. Recording the team's
 * decisions keeps the audit's date, commit and scores, so the record before
 * and after them is one point; a re-audit correcting a score is another.
 */
const sameAudit = (a: AuditRecord, b: AuditRecord) =>
  a === b || assessmentKey(a) === assessmentKey(b);

const assessmentKey = (r: AuditRecord) =>
  JSON.stringify([
    r.date,
    r.commit,
    [...r.criteria]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, c]) => [key, c.score]),
  ]);

/**
 * The past records, oldest first: each history record once, and the prior
 * record last, as the latest audit before this one, on the same day too.
 * The audited record is never among them, however often it is given.
 */
function pastRecords(input: ReportInput): AuditRecord[] {
  const now = input.record;
  const p = input.prior && !sameAudit(input.prior, now) ? input.prior : null;
  const older: AuditRecord[] = [];
  for (const h of input.history)
    if (![now, p, ...older].some((o) => o && sameAudit(o, h))) older.push(h);
  older.sort((a, b) => a.date.localeCompare(b.date));
  return p ? [...older, p] : older;
}

/** Levels in order, so two can be compared; `n/a` and an incomplete module are not on it. */
const LEVEL_ORDER: readonly (Attainment | null)[] = ["none", ...LEVELS];

/** How a module's last level stands to its first: a move, another standing (n/a or incomplete at an end), or the same. */
function endMove(levels: readonly (Attainment | null)[]): Move | "other" {
  const [first, last] = [levels[0] ?? null, levels.at(-1) ?? null];
  return moveOf(first, last) ?? (first === last ? null : "other");
}

function moveOf(before: Attainment | null, after: Attainment | null): Move {
  const [a, b] = [LEVEL_ORDER.indexOf(before), LEVEL_ORDER.indexOf(after)];
  if (a < 0 || b < 0 || a === b) return null;
  return b > a ? "up" : "down";
}

/**
 * Each module's level at every past record and now, in adoption order, for
 * the modules whose level changed at least once; null without a history. A
 * record is measured against the current catalog without the criteria its
 * plugin version did not have yet.
 */
export function trendOf(input: ReportInput): Trend | null {
  if (input.history.length === 0) return null;
  const records = [...pastRecords(input), input.record];
  const scores = records.map(scoresOf);
  const byId = new Map(input.modules.map((m) => [m.module, m]));
  const ends = { up: 0, down: 0, other: 0 };
  const rows = input.profiles.order.flatMap((id) => {
    const m = byId.get(id);
    const levels = m
      ? records.map((r, i) =>
          attainedAsOf(m, r.plugin_version, scores[i] ?? new Map()),
        )
      : [];
    if (!m || levels.every((l) => l === levels[0])) return [];
    const end = endMove(levels);
    if (end) ends[end]++;
    return [
      {
        id: m.module,
        module: moduleTitle(m),
        levels: levels.map((l, i) => ({
          word: attainedWord(l),
          move: i === 0 ? null : moveOf(levels[i - 1] ?? null, l),
        })),
      },
    ];
  });
  return {
    points: records.map((r, i) => ({
      date: r.date,
      commit: r.commit,
      current: i === records.length - 1,
    })),
    rows,
    ...ends,
    since: records[0]?.date ?? input.record.date,
  };
}

/** The trend in one line: "3 modules moved up since 2026-07-19." */
export function trendSummary(t: Trend): string {
  const counted = (
    [
      [t.up, LABEL.movedUp],
      [t.down, LABEL.movedDown],
      [t.other, LABEL.movedOther],
    ] as const
  ).filter(([n]) => n > 0);
  if (t.rows.length === 0) return LABEL.trendNone.replace("{date}", t.since);
  if (counted.length === 0) return LABEL.trendSteady.replace("{date}", t.since);
  const text = counted
    .map(([n, verb], i) =>
      i === 0 ? `${n} ${LABEL.moduleCount[plural(n)]} ${verb}` : `${n} ${verb}`,
    )
    .join(` ${LABEL.andWord} `);
  return `${text} ${LABEL.sinceWord} ${t.since}.`;
}

/** The attained level in the sheet's words. */
export function attainedWord(a: Attainment | null): string {
  return a === null ? LABEL.incomplete : LABEL.attained[a];
}

/** Why the recommendations of a later horizon are not for now, in the sheet's words. */
export function horizonWhy(horizon: Horizon, targets: Targets): string {
  const fill = (text: string) =>
    text
      .replace("{profile}", targets.profile?.name ?? "")
      .replace(
        "{heading}",
        horizon === "grow"
          ? (targets.heading?.name ?? "")
          : targets.heading
            ? LABEL.andBeyond.replace("{heading}", targets.heading.name)
            : "",
      );
  return fill(horizon === "grow" ? LABEL.growWhy : LABEL.optionalWhy);
}

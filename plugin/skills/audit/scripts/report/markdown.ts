/**
 * The Markdown copy of an audit: the same view as the sheet, in the same
 * order, as text for a pull request or a wiki. It adds only the labels in
 * `labels.ts`; every other word comes from the report source, the record or
 * the configuration-fit report. The choices are the sheet's alone: decisions
 * are made there and copied as a block.
 */
import {
  cell,
  code,
  href,
  lit,
} from "../../../decide/scripts/sheet-kit/markdown.ts";
import {
  EXPECTED_ABSENT,
  meets,
  NOT_EXAMINED,
  RUNGS,
  type Score,
} from "../lib/criteria.ts";
import type { Comparison, CriterionChange } from "../lib/record.ts";
import { FILE_STEM, LABEL, plural } from "./labels.ts";
import {
  alternativeOf,
  attainedWord,
  type Cell,
  changeRows,
  countsOf,
  examinationChanges,
  groups,
  type Horizon,
  horizonWhy,
  isApplied,
  leftOnPurpose,
  levelChanges,
  mapRows,
  type ModuleRow,
  moduleTitle,
  movedCriteria,
  type ReportInput,
  recsFor,
  SHOWN_CHANGES,
  type StillOpen,
  sinceIntro,
  sinceLast,
  startHere,
  stillOpenOf,
  type Targets,
  type Trend,
  type TrendRow,
  tally,
  targetsOf,
  trendOf,
  trendSummary,
  uncoveredGaps,
  worthWhen,
} from "./model.ts";
import type { Fit, Recommendation } from "./source.ts";

const rungWord = (score: Score | null) =>
  score === null ? LABEL.notScored : LABEL.rung[score];

function head(input: ReportInput, t: Targets): string[] {
  const { source, record } = input;
  const name = source.repository.url
    ? `[${lit(source.repository.name)}](${href(source.repository.url)})`
    : lit(source.repository.name);
  const p = t.profile
    ? `${lit(t.profile.name)} (${LABEL[t.profile.source]}${t.profile.signals.length ? `; ${LABEL.signalsLink}` : ""})`
    : LABEL.noProfile;
  const meta = [
    `**${LABEL.audited}:** ${record.date}.`,
    `**${LABEL.commit}:** ${code(record.commit.slice(0, 7))}.`,
    `**${LABEL.plugin}:** ${record.plugin_version}.`,
    `**${LABEL.profile}:** ${p}.`,
    ...(t.heading ? [`**${LABEL.headingTo}:** ${lit(t.heading.name)}.`] : []),
    ...(record.shape ? [`**${LABEL.shape}:** ${lit(record.shape)}.`] : []),
  ];
  return [
    `# ${LABEL.titleOf} ${name}`,
    "",
    meta.join(" "),
    "",
    `**${LABEL.howToReadHead}.** ${LABEL.howToRead} ${LABEL.guideIn} [${fileStem(input)}.html#guide](${fileStem(input)}.html#guide).`,
    "",
  ];
}

/** The facts that suggest revisiting the profile, as the sheet shows them beside it. */
function signals(t: Targets): string[] {
  const list = t.profile?.signals ?? [];
  if (list.length === 0) return [];
  return [
    `**${LABEL.signalsHead}.** ${LABEL.signalsIntro}`,
    "",
    ...list.map(
      (s) =>
        `- ${lit(s.text)} *${LABEL.evidence}:* ${s.evidence.map(code).join(", ")}`,
    ),
    "",
  ];
}

/** Another profile the facts support, as the sheet shows it beside the profile. */
function alternative(input: ReportInput, t: Targets): string[] {
  const alt = alternativeOf(input, t);
  if (!alt) return [];
  return [
    `**${LABEL.alternativeHead.replace("{profile}", lit(alt.name))}.** ${LABEL.alternativeAtTarget
      .replace("{profile}", lit(alt.name))
      .replace("{n}", String(alt.atTarget))
      .replace("{m}", String(alt.withTarget))}`,
    "",
    ...alt.why.map((w) => `- ${lit(w)}`),
    ...(alt.why.length ? [""] : []),
  ];
}

function inShort(input: ReportInput, rows: ModuleRow[], t: Targets): string[] {
  const n = countsOf(input, rows, t);
  const out = [`## ${LABEL.inShort}`, "", lit(input.source.summary), ""];
  if (t.profile?.why)
    out.push(`*${LABEL.whySuggested}* ${lit(t.profile.why)}`, "");
  const met = n.notExamined > 0 ? LABEL.examinedMet : LABEL.criteriaMet;
  out.push(
    `- ${n.met} ${LABEL.ofWord} ${n.applicable} ${met}${n.expectedAbsent > 0 ? `; ${n.expectedAbsent} ${LABEL.expectedAbsentCount}` : ""}${n.notExamined > 0 ? `; ${n.notExamined} ${LABEL.notExaminedCount}` : ""}`,
    `- ${n.now} ${LABEL.recommendationsNow}, ${n.quickWins} ${LABEL.quickWins}${n.later > 0 ? `; ${n.later} ${LABEL.laterCount}` : ""}${n.applied > 0 ? `; ${n.applied} ${LABEL.appliedCount}` : ""}`,
  );
  if (n.withTarget > 0)
    out.push(
      `- ${n.atTarget} ${LABEL.ofWord} ${n.withTarget} ${LABEL.modulesAtTarget}`,
    );
  if (n.uncovered > 0)
    out.push(`- ${n.uncovered} ${LABEL.uncoveredCount[plural(n.uncovered)]}`);
  if (n.left > 0) out.push(`- ${n.left} ${LABEL.leftCount[plural(n.left)]}`);
  return [...out, "", ...alternative(input, t), ...signals(t)];
}

const rungCounts = (row: ModuleRow) =>
  tally(row)
    .map((t) => `${t.n} ${rungWord(t.score)}`)
    .join(", ");

function targetCell(row: ModuleRow, t: Targets): string {
  const parts: string[] = [];
  if (row.target !== null) {
    const standing = [
      ...(row.missing > 0 ? [`${row.missing} ${LABEL.toGo}`] : []),
      ...(row.unexamined > 0
        ? [`${row.unexamined} ${LABEL.notExaminedHere}`]
        : []),
    ];
    parts.push(
      `${LABEL.levelWord[row.target]} (${standing.length ? standing.join(", ") : LABEL.atTarget})`,
    );
  } else if (t.now && !row.naReason) parts.push(LABEL.notNeeded);
  if (row.heading !== null)
    parts.push(`${LABEL.headingTo}: ${LABEL.levelWord[row.heading]}`);
  return parts.length ? parts.join("; ") : "—";
}

/** The rungs and what each means: the sheet draws them as icons, the copy names them. */
const rungLegend = () =>
  `${LABEL.rungsLegend} ${([...RUNGS, EXPECTED_ABSENT, NOT_EXAMINED] as const).map((r) => `**${LABEL.rung[r]}** (${LABEL.rungMeaning[r]})`).join(", ")}.`;

function mapTable(rows: ModuleRow[], t: Targets): string[] {
  return [
    `## ${LABEL.map}`,
    "",
    LABEL.mapIntro,
    "",
    `| ${LABEL.module} | ${LABEL.level} | ${LABEL.target} | ${LABEL.criteria} |`,
    "|--------|-------|--------|----------|",
    ...rows.map(
      (r) =>
        `| ${cell(r.title)}: ${cell(r.module.purpose)} | ${attainedWord(r.attained)} | ${targetCell(r, t)} | ${rungCounts(r)} |`,
    ),
    "",
    rungLegend(),
    "",
  ];
}

/** Where a recommendation was applied: the pull request's link or number, or the commit. */
function appliedWhere(at: string): string {
  if (at.startsWith("https://")) return `[${lit(at)}](${href(at)})`;
  if (/^#?\d+$/.test(at)) return at.startsWith("#") ? at : `#${at}`;
  return code(at.slice(0, 7));
}

const effortLine = (r: Recommendation) =>
  `${isApplied(r) && r.applied_in ? `**${LABEL.appliedIn} ${appliedWhere(r.applied_in)}** · ` : ""}*${LABEL.leverage}* ${LABEL.leverageWord[r.leverage]} · *${LABEL.effort}* ${LABEL.effortWord[r.effort]}${r.quick_win ? ` · ${LABEL.quickWin}` : ""}${r.needs ? ` · ${LABEL.needs[r.needs]}` : ""}`;

function start(input: ReportInput, t: Targets): string[] {
  const { top, quick } = startHere(input, t);
  if (top.length === 0)
    return [`## ${LABEL.startHere}`, "", LABEL.noRecommendations, ""];
  const out = [
    `## ${LABEL.startHere}`,
    "",
    ...top.map(
      (r, i) =>
        `${i + 1}. **${r.id} ${lit(r.title)}.** ${lit(r.action)} (${effortLine(r)})`,
    ),
    "",
  ];
  if (quick.length)
    out.push(
      `**${LABEL.quickWinsHead}:**`,
      "",
      ...quick.map((r) => `- **${r.id}** ${lit(r.title)}`),
      "",
    );
  return out;
}

/** Module titles by id, for the comparison's tables. */
type Titles = ReadonlyMap<string, string>;

const titlesOf = (input: ReportInput): Titles =>
  new Map(input.modules.map((m) => [m.module, moduleTitle(m)]));

const CHANGE_HEAD = `| ${LABEL.module} | ${LABEL.criterion} | ${LABEL.beforeAfter} | ${LABEL.change} |`;
const CHANGE_RULE = "|--------|-----------|----------------|--------|";

function changeLine(r: CriterionChange, word: string, titles: Titles): string {
  const [module, id] = r.key.split("/") as [string, string];
  return `| ${cell(titles.get(module) ?? module)} | ${code(id)} | ${rungWord(r.prior)} → ${rungWord(r.current)} | ${word} |`;
}

/** Every criterion that changed, worst first, as one table. */
function changes(c: Comparison, titles: Titles): string[] {
  const rows = SHOWN_CHANGES.flatMap((k) =>
    changeRows(c, k).map((r) => changeLine(r, LABEL.changes[k], titles)),
  );
  if (rows.length === 0) return [];
  return [
    `### ${LABEL.changedHead} (${rows.length})`,
    "",
    CHANGE_HEAD,
    CHANGE_RULE,
    ...rows,
    "",
  ];
}

/** The criteria examined at one audit only, apart from what changed. */
function examination(c: Comparison, titles: Titles): string[] {
  const apart = examinationChanges(c);
  const rows = (["examined", "unexamined"] as const).flatMap((k) =>
    apart[k].map((r) => changeLine(r, LABEL.examination[k], titles)),
  );
  if (rows.length === 0) return [];
  return [
    `### ${LABEL.examinationHead} (${rows.length})`,
    "",
    CHANGE_HEAD,
    CHANGE_RULE,
    ...rows,
    "",
  ];
}

const trendWord = (l: TrendRow["levels"][number]) =>
  l.move ? `${LABEL.moveArrow[l.move]} ${l.word}` : l.word;

/** The trend as a table: a column per record, oldest first, then now. */
function trendLines(t: Trend): string[] {
  const out = [`### ${LABEL.trend}`, "", trendSummary(t), ""];
  if (t.rows.length === 0) return out;
  const heads = t.points.map((p) =>
    p.current ? `${LABEL.now} ${p.date}` : p.date,
  );
  return [
    ...out,
    LABEL.trendIntro,
    "",
    `| ${LABEL.module} | ${heads.join(" | ")} |`,
    `|--------|${heads.map(() => "---").join("|")}|`,
    ...t.rows.map(
      (r) => `| ${cell(r.module)} | ${r.levels.map(trendWord).join(" | ")} |`,
    ),
    "",
  ];
}

function levelLines(input: ReportInput, c: Comparison): string[] {
  const trend = trendOf(input);
  // The trend holds the prior record's levels, so it takes the levels table's place.
  if (trend) return trendLines(trend);
  const levels = levelChanges(c, input.modules);
  if (levels.length === 0) return [];
  return [
    `### ${LABEL.levelsChanged}`,
    "",
    `| ${LABEL.module} | ${LABEL.prior} | ${LABEL.now} |`,
    "|--------|-------|-----|",
    ...levels.map((l) => `| ${l.module} | ${l.prior} | ${l.current} |`),
    "",
  ];
}

/** The criteria still open within the target; those beyond it are only counted, as the sheet folds them. */
function stillOpenLines(open: StillOpen | null, titles: Titles): string[] {
  if (!open) return [];
  const out: string[] = [];
  if (open.within.length)
    out.push(
      `### ${LABEL.stillOpenHead} (${open.within.length})`,
      "",
      CHANGE_HEAD,
      CHANGE_RULE,
      ...open.within.map((r) => changeLine(r, LABEL.stillOpen, titles)),
      "",
    );
  if (open.beyond.length)
    out.push(
      LABEL.stillOpenBeyondNote.replace("{n}", String(open.beyond.length)),
      "",
    );
  return out;
}

function since(
  input: ReportInput,
  c: Comparison,
  open: StillOpen | null,
): string[] {
  const titles = titlesOf(input);
  const out = [
    `## ${LABEL.since}`,
    "",
    sinceIntro(input.prior, c, open),
    "",
    ...changes(c, titles),
    ...examination(c, titles),
    ...stillOpenLines(open, titles),
    ...levelLines(input, c),
  ];
  if (c.declined.length)
    out.push(
      `### ${LABEL.declinedHead}`,
      "",
      ...c.declined.map(
        (d) =>
          `- **${LABEL.declinedStatus[d.status]}** ${d.entry.refs.map(code).join(", ")}: ${lit(d.why)}`,
      ),
      "",
    );
  return out;
}

function recommendation(
  input: ReportInput,
  t: Targets,
  r: Recommendation,
  horizon: Horizon,
): string[] {
  const requires = new Map(
    input.modules.flatMap((m) => m.criteria.map((c) => [c.key, c.requires])),
  );
  const moves = movedCriteria(r, input.record).map((m) => {
    const bar = requires.get(m.ref);
    return bar
      ? `${code(m.ref)} (${rungWord(m.score)}, ${LABEL.requires} ${bar})`
      : code(m.ref);
  });
  const when = horizon === "now" ? null : worthWhen(r, input, t);
  return [
    `#### ${r.id}. ${lit(r.title)}`,
    "",
    effortLine(r),
    "",
    `- **${LABEL.finding}:** ${lit(r.finding)}`,
    `- **${LABEL.action}:** ${lit(r.action)}`,
    ...(r.lighter ? [`- **${LABEL.lighter}:** ${lit(r.lighter)}`] : []),
    `- **${LABEL.evidence}:** ${r.evidence.map(code).join(", ")}`,
    `- **${LABEL.moves}:** ${moves.join(", ")}`,
    ...(when ? [`- **${LABEL.worthWhen}** ${lit(when)}`] : []),
    "",
  ];
}

function horizonBlock(
  input: ReportInput,
  t: Targets,
  horizon: Horizon,
): string[] {
  const recs = recsFor(horizon, input, t);
  if (recs.length === 0) return [];
  const out =
    horizon === "now"
      ? []
      : [
          `### ${LABEL.horizon[horizon]} (${recs.length})`,
          "",
          horizonWhy(horizon, t),
          "",
        ];
  for (const g of groups(input, recs))
    out.push(
      `${horizon === "now" ? "###" : "####"} ${lit(g.title)}`,
      "",
      lit(g.purpose),
      "",
      ...g.recs.flatMap((r) => recommendation(input, t, r, horizon)),
    );
  return out;
}

/** The gaps within the target no recommendation moves. */
function uncoveredLines(rows: readonly ModuleRow[]): string[] {
  const cells = uncoveredGaps(rows);
  if (cells.length === 0) return [];
  return [
    `### ${LABEL.uncoveredHead} (${cells.length})`,
    "",
    LABEL.uncoveredIntro,
    "",
    ...cells.map(
      (c) => `- ${code(c.criterion.key)}: ${lit(c.criterion.statement)}`,
    ),
    "",
  ];
}

/** What the report leaves on purpose, each with its reason. */
function leftLines(input: ReportInput): string[] {
  const left = leftOnPurpose(input);
  if (left.length === 0) return [];
  return [
    `### ${LABEL.leftHead} (${left.flatMap((l) => l.refs).length})`,
    "",
    LABEL.leftIntro,
    "",
    ...left.map(
      (l) =>
        `- ${l.refs.map(code).join(", ")}: ${lit(l.reason)}${l.revisit_when ? ` ${LABEL.revisitWhen} ${lit(l.revisit_when)}` : ""}`,
    ),
    "",
  ];
}

function recommendations(
  input: ReportInput,
  rows: readonly ModuleRow[],
  t: Targets,
): string[] {
  const uncovered = [...uncoveredLines(rows), ...leftLines(input)];
  const none = input.source.recommendations.length === 0;
  if (none && uncovered.length === 0) return [];
  return [
    `## ${LABEL.recommendations}`,
    "",
    ...(none ? [LABEL.noRecommendations, ""] : []),
    ...horizonBlock(input, t, "now"),
    ...uncovered,
    ...horizonBlock(input, t, "grow"),
    ...horizonBlock(input, t, "optional"),
  ];
}

/** Where a criterion stands against the profile, when that matters. */
function standingNote(c: Cell): string {
  if (c.score === NOT_EXAMINED) return "";
  if (c.uncovered) return `${LABEL.gapLegend}; ${LABEL.uncoveredLegend}`;
  if (c.left) return `${LABEL.gapLegend}; ${LABEL.leftLegend}`;
  if (c.gap) return LABEL.gapLegend;
  const met = c.score !== null && meets(c.score, c.criterion.requires);
  return c.inTarget === false && !met ? LABEL.notNeeded : "";
}

/** The score, with where it stands against the profile when that matters. */
function scoreCell(c: Cell): string {
  const note = standingNote(c);
  return `**${rungWord(c.score)}**${note ? ` (${note})` : ""}`;
}

function detail(rows: ModuleRow[]): string[] {
  const out = [`## ${LABEL.detail}`, "", LABEL.detailIntro, ""];
  for (const row of rows) {
    out.push(
      `### ${lit(row.title)}: ${attainedWord(row.attained)}`,
      "",
      `| ${LABEL.criterion} | ${LABEL.level} | ${LABEL.requiresHead} | ${LABEL.score} | ${LABEL.decidedBy} | ${LABEL.evidence} |`,
      "|-----------|-------|----------|-------|------------|----------|",
      ...row.cells.map(
        (c) =>
          `| **${c.criterion.id}**: ${cell(c.criterion.statement)} | ${LABEL.levelWord[c.criterion.level]} | ${c.criterion.requires} | ${scoreCell(c)} | ${c.decidedBy === "probe" ? LABEL.byProbe : LABEL.byAgent} | ${cell(c.evidence ?? "")} |`,
      ),
      "",
    );
  }
  return out;
}

function fitFindings(fit: Fit): string[] {
  const out: string[] = [];
  for (const sev of ["error", "warning", "suggestion", "info"] as const) {
    const rows = fit.findings.filter((f) => f.severity === sev);
    if (rows.length === 0) continue;
    out.push(
      `### ${LABEL.severity[sev]} (${rows.length})`,
      "",
      ...rows.map((f) => `- ${code(`config/${f.id}`)}: ${lit(f.message)}`),
      "",
    );
  }
  return out;
}

/** The starter configuration in a fence longer than any backtick run inside it, so nothing in it can close the fence. */
function draftBlock(draft: string): string[] {
  const fence = "`".repeat(
    Math.max(3, ...(draft.match(/`+/g) ?? []).map((m) => m.length + 1)),
  );
  return [
    `### ${LABEL.draft}`,
    "",
    LABEL.draftIntro,
    "",
    `${fence}yaml`,
    draft.trimEnd(),
    fence,
    "",
  ];
}

function fitExtras(fit: Fit): string[] {
  const out: string[] = [];
  const facts = Object.entries(fit.facts);
  if (facts.length)
    out.push(
      `### ${LABEL.facts}`,
      "",
      ...facts.map(([k, v]) => `- ${lit(k)}: ${lit(v)}`),
      "",
    );
  if (fit.declined.length)
    out.push(
      `### ${LABEL.declinedFindings} (${fit.declined.length})`,
      "",
      ...fit.declined.map(
        (d) =>
          `- ${code(`config/${d.finding.id}`)}: ${lit(d.reason)} ${LABEL.revisitWhen} ${lit(d.revisit_when)}`,
      ),
      "",
    );
  if (fit.draft) out.push(...draftBlock(fit.draft));
  return out;
}

function config(fit: Fit | null): string[] {
  const out = [`## ${LABEL.config}`, ""];
  if (!fit) return [...out, LABEL.noFit, ""];
  out.push(
    `**${LABEL.configFile}:** ${code(fit.file)}. **${LABEL.forge}:** ${lit(fit.forge)}.`,
    "",
  );
  if (!fit.configured) out.push(LABEL.configNone, "");
  if (fit.findings.every((f) => f.severity === "info"))
    out.push(LABEL.nothingToFix, "");
  return [...out, ...fitFindings(fit), ...fitExtras(fit)];
}

function drift(input: ReportInput): string[] {
  const items = input.source.drift ?? [];
  return [
    `## ${LABEL.drift}`,
    "",
    LABEL.driftIntro,
    "",
    ...(items.length
      ? items.map(
          (d) =>
            `- ${lit(d.text)} *${LABEL.evidence}:* ${d.evidence.map(code).join(", ")}`,
        )
      : [LABEL.noDrift]),
    "",
  ];
}

function examined(input: ReportInput): string[] {
  const { stack, examined: ex } = input.source;
  const out = [
    `## ${LABEL.examined}`,
    "",
    `### ${LABEL.stack}`,
    "",
    `| ${LABEL.facet} | ${LABEL.detected} | ${LABEL.evidence} |`,
    "|-------|----------|----------|",
    ...stack.map(
      (s) => `| ${cell(s.facet)} | ${cell(s.detected)} | ${code(s.evidence)} |`,
    ),
    "",
    `### ${LABEL.read}`,
    "",
    ...ex.read.map((r) => `- ${lit(r)}`),
    "",
  ];
  if (ex.unchecked?.length)
    out.push(
      `### ${LABEL.unchecked}`,
      "",
      ...ex.unchecked.map((u) => `- **${lit(u.what)}**: ${lit(u.why)}`),
      "",
    );
  out.push(`### ${LABEL.method}`, "", LABEL.methodText, "");
  return out;
}

export function renderReportMarkdown(input: ReportInput): string {
  const t = targetsOf(input);
  const rows = mapRows(input, t);
  const comparison = sinceLast(input);
  const md = [
    ...head(input, t),
    ...inShort(input, rows, t),
    ...mapTable(rows, t),
    ...start(input, t),
    ...(comparison
      ? since(input, comparison, stillOpenOf(comparison, rows, t))
      : []),
    ...recommendations(input, rows, t),
    ...detail(rows),
    ...config(input.fit),
    ...drift(input),
    ...examined(input),
  ];
  if (input.source.terms?.length)
    md.push(
      `## ${LABEL.terms}`,
      "",
      ...input.source.terms.map(
        (g) => `- **${lit(g.term)}:** ${lit(g.meaning)}`,
      ),
      "",
    );
  return `${md.join("\n").trimEnd()}\n`;
}

/** The file name of a rendered sheet or copy, without the extension. */
export const fileStem = (input: ReportInput) =>
  `${FILE_STEM}${input.record.date}`;

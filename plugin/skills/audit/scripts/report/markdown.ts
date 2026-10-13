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
import { meets, type Score } from "../lib/criteria.ts";
import type { Comparison } from "../lib/record.ts";
import { FILE_STEM, LABEL } from "./labels.ts";
import {
  attainedWord,
  type Cell,
  countsOf,
  groups,
  type Horizon,
  horizonWhy,
  levelChanges,
  mapRows,
  type ModuleRow,
  movedCriteria,
  type ReportInput,
  recsFor,
  SHOWN_CHANGES,
  sinceIntro,
  sinceLast,
  startHere,
  type Targets,
  tally,
  targetsOf,
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
    ? `${lit(t.profile.name)} (${LABEL[t.profile.source]})`
    : LABEL.noProfile;
  const meta = [
    `**${LABEL.audited}:** ${record.date}.`,
    `**${LABEL.commit}:** ${code(record.commit.slice(0, 7))}.`,
    `**${LABEL.plugin}:** ${record.plugin_version}.`,
    `**${LABEL.profile}:** ${p}.`,
    ...(t.heading ? [`**${LABEL.headingTo}:** ${lit(t.heading.name)}.`] : []),
    ...(record.shape ? [`**${LABEL.shape}:** ${lit(record.shape)}.`] : []),
  ];
  return [`# ${LABEL.titleOf} ${name}`, "", meta.join(" "), ""];
}

function inShort(input: ReportInput, rows: ModuleRow[], t: Targets): string[] {
  const n = countsOf(input, rows, t);
  const out = [`## ${LABEL.inShort}`, "", lit(input.source.summary), ""];
  if (t.profile?.why)
    out.push(`*${LABEL.whySuggested}* ${lit(t.profile.why)}`, "");
  out.push(
    `- ${n.met} ${LABEL.ofWord} ${n.applicable} ${LABEL.criteriaMet}${n.expectedAbsent > 0 ? `; ${n.expectedAbsent} ${LABEL.expectedAbsentCount}` : ""}`,
    `- ${n.now} ${LABEL.recommendationsNow}, ${n.quickWins} ${LABEL.quickWins}${n.later > 0 ? `; ${n.later} ${LABEL.laterCount}` : ""}`,
  );
  if (n.withTarget > 0)
    out.push(
      `- ${n.atTarget} ${LABEL.ofWord} ${n.withTarget} ${LABEL.modulesAtTarget}`,
    );
  return [...out, ""];
}

const rungCounts = (row: ModuleRow) =>
  tally(row)
    .map((t) => `${t.n} ${rungWord(t.score)}`)
    .join(", ");

function targetCell(row: ModuleRow, t: Targets): string {
  const parts: string[] = [];
  if (row.target !== null)
    parts.push(
      `${LABEL.levelWord[row.target]} (${row.missing === 0 ? LABEL.atTarget : `${row.missing} ${LABEL.toGo}`})`,
    );
  else if (t.now && !row.naReason) parts.push(LABEL.notNeeded);
  if (row.heading !== null)
    parts.push(`${LABEL.headingTo}: ${LABEL.levelWord[row.heading]}`);
  return parts.length ? parts.join("; ") : "—";
}

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
  ];
}

const effortLine = (r: Recommendation) =>
  `*${LABEL.leverage}* ${LABEL.leverageWord[r.leverage]} · *${LABEL.effort}* ${LABEL.effortWord[r.effort]}${r.quick_win ? ` · ${LABEL.quickWin}` : ""}`;

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

function changes(c: Comparison): string[] {
  const out: string[] = [];
  for (const change of SHOWN_CHANGES) {
    const rows = c.criteria.filter((r) => r.change === change);
    if (rows.length === 0) continue;
    out.push(
      `### ${LABEL.changes[change]} (${rows.length})`,
      "",
      ...rows.map(
        (r) =>
          `- ${code(r.key)}: ${rungWord(r.prior)} → ${rungWord(r.current)}`,
      ),
      "",
    );
  }
  return out;
}

function since(input: ReportInput, c: Comparison): string[] {
  const out = [
    `## ${LABEL.since}`,
    "",
    sinceIntro(input.prior, c),
    "",
    ...changes(c),
  ];
  const levels = levelChanges(c, input.modules);
  if (levels.length)
    out.push(
      `### ${LABEL.levelsChanged}`,
      "",
      `| ${LABEL.module} | ${LABEL.prior} | ${LABEL.now} |`,
      "|--------|-------|-----|",
      ...levels.map((l) => `| ${l.module} | ${l.prior} | ${l.current} |`),
      "",
    );
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

function recommendations(input: ReportInput, t: Targets): string[] {
  if (input.source.recommendations.length === 0) return [];
  return [
    `## ${LABEL.recommendations}`,
    "",
    ...horizonBlock(input, t, "now"),
    ...horizonBlock(input, t, "grow"),
    ...horizonBlock(input, t, "optional"),
  ];
}

/** The score, with where it stands against the profile when that matters. */
function scoreCell(c: Cell): string {
  const met = c.score !== null && meets(c.score, c.criterion.requires);
  const note = c.gap
    ? ` (${LABEL.gapLegend})`
    : c.inTarget === false && !met
      ? ` (${LABEL.notNeeded})`
      : "";
  return `**${rungWord(c.score)}**${note}`;
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
    ...(comparison ? since(input, comparison) : []),
    ...recommendations(input, t),
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

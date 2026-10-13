/**
 * The HTML projection of an audit, on the sheet kit: the audit sheet.
 *
 * The order is the reading order a team needs: the masthead, the summary
 * with the counts beside it, the maturity map, the moves to start with, what
 * changed since the last audit, every recommendation by module in adoption
 * order with its choices, the detail of every criterion, the configuration
 * fit, the drift, what was examined, and the terms.
 *
 * The profile is the measure, never a verdict: only a criterion within the
 * target that is not met yet is marked as a gap, and recommendations the
 * profile does not ask for yet sit in their own folded groups, "as you grow"
 * and "optional", each saying why.
 *
 * The page is self-contained and reads without JavaScript and in print: the
 * choices, the profile selector, the copy buttons and the tray are rendered
 * hidden (`data-js`) and the script shows them; the folded groups render open
 * and the script folds them. It embeds everything it was rendered from in one
 * JSON block, so `report.ts extract` recovers the source, the record, the fit
 * report and the prior record from the file.
 */
import {
  esc,
  extLink,
  navItem,
  page,
  section,
  termList,
  topBar,
} from "../../../decide/scripts/sheet-kit/html.ts";
import {
  createInline,
  type Inline,
} from "../../../decide/scripts/sheet-kit/inline.ts";
import {
  EXPECTED_ABSENT,
  LEVELS,
  meets,
  RUNGS,
  type Score,
} from "../lib/criteria.ts";
import type { Comparison } from "../lib/record.ts";
import { REPORT_CSS } from "./css.ts";
import { DATA_BLOCK_ID, embeddedData } from "./data.ts";
import { CHOICES } from "./feedback-text.ts";
import { LABEL, SHEET_LABEL } from "./labels.ts";
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
import { REPORT_SCRIPT } from "./script.ts";
import type { Fit, FitFinding, Recommendation } from "./source.ts";

/** The principle behind the ladder, in Jig's own repository. */
const LADDER_URL =
  "https://github.com/docomply/jig/blob/main/principles/04-enforcement-ladder.md";

type Rich = (text: string) => string;

/** What every section reads: the input, the targets, the map rows and the term linker. */
interface Ctx {
  input: ReportInput;
  targets: Targets;
  rows: ModuleRow[];
  inline: Inline;
}

/** A fresh region for term links: each term links at its first use in a section. */
function richIn(ctx: Ctx): Rich {
  const seen = new Set<string>();
  return (text) => ctx.inline.textHtml(text, seen);
}

const rungClass = (score: Score | null) => score ?? "unscored";
const rungWord = (score: Score | null) =>
  score === null ? LABEL.notScored : LABEL.rung[score];
const scoreChip = (score: Score | null) =>
  `<span class="sch s-${rungClass(score)}">${esc(rungWord(score))}</span>`;
const codes = (items: readonly string[]) =>
  `<ul class="ev">${items.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`;
const lvClass = (row: ModuleRow) =>
  row.attained === "none" || row.attained === "n/a" ? "lv lv-none" : "lv";

// ---------- masthead and summary ----------

function profileHtml(t: Targets): string {
  if (!t.profile) return esc(LABEL.noProfile);
  return `${esc(t.profile.name)} <span class="pchip p-${t.profile.source}">${esc(LABEL[t.profile.source])}</span>`;
}

function masthead(ctx: Ctx): string {
  const { source, record } = ctx.input;
  const name = source.repository.url
    ? extLink(source.repository.url, source.repository.name)
    : esc(source.repository.name);
  const meta: [string, string, string][] = [
    [LABEL.audited, esc(record.date), ""],
    [
      LABEL.commit,
      esc(record.commit.slice(0, 7)),
      ` class="mono" title="${esc(record.commit)}"`,
    ],
    [LABEL.plugin, esc(record.plugin_version), ""],
    [LABEL.profile, profileHtml(ctx.targets), ""],
  ];
  if (ctx.targets.heading)
    meta.push([LABEL.headingTo, esc(ctx.targets.heading.name), ""]);
  if (record.shape) meta.push([LABEL.shape, esc(record.shape), ""]);
  const dl = meta
    .map(
      ([dt, dd, attr]) => `<div><dt>${esc(dt)}</dt><dd${attr}>${dd}</dd></div>`,
    )
    .join("");
  return `<header class="sec mast"><p class="lab mast-id">${esc(LABEL.sheet)}<span>${esc(record.date)}</span></p><div class="body"><h1>${esc(LABEL.titleOf)} ${name}</h1><dl class="meta">${dl}</dl></div></header>`;
}

function stats(ctx: Ctx): string {
  const n = countsOf(ctx.input, ctx.rows, ctx.targets);
  const of = (a: number, b: number) =>
    `<span class="big">${a} <small>${esc(LABEL.ofWord)} ${b}</small></span>`;
  const later = n.later > 0 ? `; ${n.later} ${esc(LABEL.laterCount)}` : "";
  const items = [
    `<li class="met">${of(n.met, n.applicable)}${esc(LABEL.criteriaMet)}${n.expectedAbsent > 0 ? `; ${n.expectedAbsent} ${esc(LABEL.expectedAbsentCount)}` : ""}</li>`,
    `<li><span class="big">${n.now}</span>${esc(LABEL.recommendationsNow)}, ${n.quickWins} ${esc(LABEL.quickWins)}${later}</li>`,
  ];
  if (n.withTarget > 0)
    items.push(
      `<li>${of(n.atTarget, n.withTarget)}${esc(LABEL.modulesAtTarget)}</li>`,
    );
  return `<ul class="stats">${items.join("")}</ul>`;
}

function inShort(ctx: Ctx): string {
  const rich = richIn(ctx);
  const why = ctx.targets.profile?.why
    ? `<p class="why"><b>${esc(LABEL.whySuggested)}</b> ${rich(ctx.targets.profile.why)}</p>`
    : "";
  return section(
    LABEL.inShort,
    `<div class="main"><p class="lead">${rich(ctx.input.source.summary)}</p>${why}</div><aside class="side">${stats(ctx)}</aside>`,
    { id: "summary", pair: true },
  );
}

// ---------- the maturity map ----------

function legend(t: Targets): string {
  const swatch = (cls: string, word: string, meaning: string) =>
    `<li><i class="${cls}" aria-hidden="true"></i><span><b>${esc(word)}</b> ${esc(meaning)}</span></li>`;
  const items = ([...RUNGS, EXPECTED_ABSENT] as const).map((r) =>
    swatch(`c c-${r}`, LABEL.rung[r], LABEL.rungMeaning[r]),
  );
  items.push(swatch("c c-unscored", LABEL.notScored, LABEL.notScoredMeaning));
  if (t.now) {
    items.push(
      `<li><i class="c c-absent gap" aria-hidden="true"></i><span>${esc(LABEL.gapLegend)}</span></li>`,
      `<li><span class="bracket" aria-hidden="true"></span><span>${esc(LABEL.withinTarget)}</span></li>`,
    );
  }
  if (t.heading)
    items.push(
      `<li><span class="bracket grow" aria-hidden="true"></span><span>${esc(LABEL.withinHeading)} (${esc(t.heading.name)})</span></li>`,
    );
  return `<ul class="legend">${items.join("")}</ul>`;
}

/** What the squares show, for a reader who cannot see them: each rung with its count. */
function cellsLabel(row: ModuleRow): string {
  const gaps = row.cells.filter((c) => c.gap).length;
  const parts = tally(row).map((t) => `${t.n} ${rungWord(t.score)}`);
  if (gaps > 0) parts.push(`${gaps} ${LABEL.gapLegend}`);
  return `${row.module.module}: ${parts.join(", ")}`;
}

/** Which bracket a level's squares sit over: the target's, the heading-to profile's, or none. */
function groupClass(row: ModuleRow, i: number): string {
  const upTo = (l: ModuleRow["target"]) =>
    l === null ? -1 : LEVELS.indexOf(l);
  if (i <= upTo(row.target)) return "grp in";
  return i <= upTo(row.heading) ? "grp grow" : "grp";
}

function cells(row: ModuleRow): string {
  const groupsHtml = LEVELS.map((level, i) => {
    const own = row.cells.filter((c) => c.criterion.level === level);
    if (own.length === 0) return "";
    const squares = own
      .map(
        (c) =>
          `<i class="c c-${rungClass(c.score)}${c.gap ? " gap" : ""}" title="${esc(`${c.criterion.id}: ${rungWord(c.score)}`)}"></i>`,
      )
      .join("");
    return `<span class="${groupClass(row, i)}" title="${esc(LABEL.levelWord[level])}">${squares}</span>`;
  }).join("");
  return `<div class="cells" role="img" aria-label="${esc(cellsLabel(row))}">${groupsHtml}</div>`;
}

function levelCell(row: ModuleRow, t: Targets): string {
  const parts = [
    `<span class="${lvClass(row)}">${esc(attainedWord(row.attained))}</span>`,
  ];
  if (row.target !== null) {
    parts.push(
      `<span class="tgt">${esc(LABEL.target)}: ${esc(LABEL.levelWord[row.target])}</span>`,
      row.missing === 0
        ? `<span class="ok">${esc(LABEL.atTarget)}</span>`
        : `<span class="go">${row.missing} ${esc(LABEL.toGo)}</span>`,
    );
  } else if (t.now && !row.naReason)
    parts.push(`<span class="tgt">${esc(LABEL.notNeeded)}</span>`);
  if (row.heading !== null)
    parts.push(
      `<span class="tgt hd">${esc(LABEL.headingTo)}: ${esc(LABEL.levelWord[row.heading])}</span>`,
    );
  return `<div class="mlev">${parts.join("")}</div>`;
}

function mapRow(row: ModuleRow, t: Targets): string {
  const name = row.title.slice(row.module.module.length + 1);
  const na = row.naReason
    ? `<p class="na-why">${esc(LABEL.notApplicable)} ${esc(row.naReason)}</p>`
    : "";
  return `<li class="mrow${row.naReason ? " na" : ""}" id="map-${esc(row.module.module)}"><div><p class="mname"><code>${esc(row.module.module)}</code>${esc(name)}</p><p class="mpur">${esc(row.module.purpose)}</p>${na}</div>${levelCell(row, t)}${cells(row)}</li>`;
}

function profilePicker(input: ReportInput): string {
  const declared = input.record.profile
    ? input.profiles.profiles.get(input.record.profile)?.name
    : undefined;
  const options = [
    `<option value="">${esc(SHEET_LABEL.profileKeep)}: ${esc(declared ?? LABEL.noProfile)}</option>`,
    ...[...input.profiles.profiles.values()].map(
      (p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`,
    ),
  ];
  return `<p class="psel" data-js hidden><label for="profile-pick">${esc(SHEET_LABEL.profileChange)}</label><select id="profile-pick">${options.join("")}</select></p>`;
}

function mapSection(ctx: Ctx): string {
  const head = `<div class="mhead" aria-hidden="true"><span>${esc(LABEL.module)}</span><span>${esc(LABEL.level)}</span><span>${esc(LABEL.criteria)}</span></div>`;
  return section(
    LABEL.map,
    `<p class="intro">${esc(LABEL.mapIntro)}</p>${legend(ctx.targets)}${head}<ol class="mmap">${ctx.rows.map((r) => mapRow(r, ctx.targets)).join("")}</ol>${profilePicker(ctx.input)}`,
    { id: "map" },
  );
}

// ---------- recommendations ----------

function tags(r: Recommendation): string {
  return `<div class="tags"><span class="tag">${esc(LABEL.leverage)} <b>${esc(LABEL.leverageWord[r.leverage])}</b></span><span class="tag">${esc(LABEL.effort)} <b>${esc(LABEL.effortWord[r.effort])}</b></span>${r.quick_win ? `<span class="tag tag-qw">${esc(LABEL.quickWin)}</span>` : ""}</div>`;
}

const recLink = (r: Recommendation) =>
  `<a class="rid" href="#rec-${esc(r.id)}">${esc(r.id)}</a>`;

function startSection(ctx: Ctx): string {
  const rich = richIn(ctx);
  const { top, quick } = startHere(ctx.input, ctx.targets);
  if (top.length === 0)
    return section(LABEL.startHere, `<p>${esc(LABEL.noRecommendations)}</p>`, {
      id: "start",
    });
  const cards = top
    .map(
      (r) =>
        `<li class="sc"><div class="rec-h">${recLink(r)}<h4><a href="#rec-${esc(r.id)}">${esc(r.title)}</a></h4></div><p>${rich(r.action)}</p>${tags(r)}</li>`,
    )
    .join("");
  const wins = quick.length
    ? `<h3 class="sub">${esc(LABEL.quickWinsHead)}</h3><ul class="qw">${quick.map((r) => `<li>${recLink(r)}<a href="#rec-${esc(r.id)}">${esc(r.title)}</a></li>`).join("")}</ul>`
    : "";
  return section(
    LABEL.startHere,
    `<h3 class="sub">${esc(LABEL.topMoves)}</h3><ol class="top">${cards}</ol>${wins}`,
    { id: "start" },
  );
}

function moved(input: ReportInput, r: Recommendation): string {
  const requires = new Map(
    input.modules.flatMap((m) => m.criteria.map((c) => [c.key, c.requires])),
  );
  return `<ul class="mv">${movedCriteria(r, input.record)
    .map((m) => {
      const bar = requires.get(m.ref);
      return `<li><code>${esc(m.ref)}</code>${bar ? `${scoreChip(m.score)}<span class="tgt">${esc(LABEL.requires)} ${esc(bar)}</span>` : ""}</li>`;
    })
    .join("")}</ul>`;
}

/** The choices of a card: hidden until the script runs, since only the script can act on them. */
function choices(r: Recommendation): string {
  const id = esc(r.id);
  const radios = CHOICES.filter((k) => k !== "lighter" || r.lighter)
    .map(
      (k) =>
        `<label class="ch ch-${k}"><input type="radio" name="c-${id}" value="${k}"><span>${esc(SHEET_LABEL.choice[k])}</span></label>`,
    )
    .join("");
  return `<fieldset class="choose" data-js hidden><legend>${esc(SHEET_LABEL.yourDecision)} ${id}</legend><div class="opts">${radios}<button type="button" class="clr" hidden>${esc(SHEET_LABEL.clear)}</button></div><div class="more" hidden><label data-for="decline">${esc(SHEET_LABEL.why)}<textarea data-f="reason" rows="2"></textarea></label><label data-for="decline">${esc(SHEET_LABEL.revisit)}<input type="text" data-f="when"></label><label data-for="refine wrong lighter">${esc(SHEET_LABEL.note)}<textarea data-f="note" rows="2"></textarea></label></div></fieldset>`;
}

function card(
  ctx: Ctx,
  r: Recommendation,
  horizon: Horizon,
  rich: Rich,
): string {
  const fields: [string, string][] = [
    [LABEL.finding, rich(r.finding)],
    [LABEL.action, rich(r.action)],
  ];
  if (r.lighter) fields.push([LABEL.lighter, rich(r.lighter)]);
  fields.push(
    [LABEL.evidence, codes(r.evidence)],
    [LABEL.moves, moved(ctx.input, r)],
  );
  const when = horizon === "now" ? null : worthWhen(r, ctx.input, ctx.targets);
  if (when) fields.push([LABEL.worthWhen, rich(when)]);
  const dl = fields
    .map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`)
    .join("");
  return `<li><article class="rec" id="rec-${esc(r.id)}" data-rec="${esc(r.id)}"><div class="rec-h"><span class="rid">${esc(r.id)}</span><h4>${esc(r.title)}</h4></div>${tags(r)}<dl class="fields">${dl}</dl>${choices(r)}</article></li>`;
}

function groupsHtml(
  ctx: Ctx,
  recs: Recommendation[],
  horizon: Horizon,
  rich: Rich,
): string {
  return groups(ctx.input, recs)
    .map(
      (g) =>
        `<h3 class="grp-h" id="g-${horizon}-${esc(g.id)}">${esc(g.title)}</h3><p class="grp-p">${esc(g.purpose)}</p><ol class="recs">${g.recs.map((r) => card(ctx, r, horizon, rich)).join("")}</ol>`,
    )
    .join("");
}

/** A later horizon: open as rendered, folded by the script, with why it is not for now. */
function laterGroup(ctx: Ctx, horizon: Horizon, rich: Rich): string {
  const recs = recsFor(horizon, ctx.input, ctx.targets);
  if (recs.length === 0) return "";
  return `<details class="later" id="h-${horizon}" open data-fold><summary><span class="later-h">${esc(LABEL.horizon[horizon])}</span> <span class="later-n">(${recs.length})</span></summary><p class="intro">${esc(horizonWhy(horizon, ctx.targets))}</p>${groupsHtml(ctx, recs, horizon, rich)}</details>`;
}

function recsSection(ctx: Ctx): string {
  const rich = richIn(ctx);
  const now = recsFor("now", ctx.input, ctx.targets);
  const body =
    groupsHtml(ctx, now, "now", rich) +
    laterGroup(ctx, "grow", rich) +
    laterGroup(ctx, "optional", rich);
  return section(LABEL.recommendations, body, { id: "recs", cls: "heavy" });
}

// ---------- since the last audit ----------

function changeList(c: Comparison): string {
  return SHOWN_CHANGES.map((change) => {
    const rows = c.criteria.filter((r) => r.change === change);
    if (rows.length === 0) return "";
    const cls =
      change === "regressed" ? " gone" : change === "fixed" ? " got" : "";
    return `<h3 class="sev-h${cls}">${esc(LABEL.changes[change])} (${rows.length})</h3><ul class="chg">${rows.map((r) => `<li><code>${esc(r.key)}</code> ${esc(rungWord(r.prior))} → ${esc(rungWord(r.current))}</li>`).join("")}</ul>`;
  }).join("");
}

function declinedList(c: Comparison): string {
  if (c.declined.length === 0) return "";
  return `<h3 class="sev-h">${esc(LABEL.declinedHead)}</h3><ul class="fl">${c.declined.map((d) => `<li><b>${esc(LABEL.declinedStatus[d.status])}</b> ${d.entry.refs.map((r) => `<code>${esc(r)}</code>`).join(" ")} ${esc(d.why)}</li>`).join("")}</ul>`;
}

function levelTable(input: ReportInput, c: Comparison): string {
  const changes = levelChanges(c, input.modules);
  if (changes.length === 0) return "";
  return `<h3 class="sev-h">${esc(LABEL.levelsChanged)}</h3><table class="stack"><thead><tr><th>${esc(LABEL.module)}</th><th>${esc(LABEL.prior)}</th><th>${esc(LABEL.now)}</th></tr></thead><tbody>${changes.map((l) => `<tr><td>${esc(l.module)}</td><td>${esc(l.prior)}</td><td>${esc(l.current)}</td></tr>`).join("")}</tbody></table>`;
}

function sinceSection(input: ReportInput, c: Comparison): string {
  const intro = `<p class="intro">${esc(sinceIntro(input.prior, c))}</p>`;
  const body = changeList(c) + levelTable(input, c) + declinedList(c);
  return section(
    LABEL.since,
    intro + (body || `<p>${esc(LABEL.noChange)}</p>`),
    { id: "since" },
  );
}

// ---------- module detail ----------

/** Where a criterion stands against the profile: needed and not met, or not needed and not met. */
function standing(c: Cell): string {
  if (c.gap) return `<span class="gapt">${esc(LABEL.gapLegend)}</span>`;
  const met = c.score !== null && meets(c.score, c.criterion.requires);
  return c.inTarget === false && !met
    ? `<span class="nn">${esc(LABEL.notNeeded)}</span>`
    : "";
}

function criterionItem(c: Cell): string {
  const by = c.decidedBy === "probe" ? LABEL.byProbe : LABEL.byAgent;
  return `<li><div><p class="cid">${esc(c.criterion.id)}</p><p class="stm">${esc(c.criterion.statement)}</p></div><div class="chips"><span>${esc(LABEL.levelWord[c.criterion.level])}</span><span>${esc(LABEL.requires)} ${esc(c.criterion.requires)}</span>${scoreChip(c.score)}${standing(c)}</div><p class="cev"><b>${esc(LABEL.decidedBy)} ${esc(by)}.</b> ${esc(c.evidence ?? "")}</p></li>`;
}

function detailSection(rows: ModuleRow[]): string {
  const body = rows
    .map(
      (row) =>
        // Open in the file, so the detail reads without a script and in print;
        // the script folds it like the later recommendations.
        `<details class="mod" open data-fold><summary><h3 class="mod-h" id="d-${esc(row.module.module)}">${esc(row.title)}<span class="${lvClass(row)}">${esc(attainedWord(row.attained))}</span></h3></summary><ol class="crit">${row.cells.map(criterionItem).join("")}</ol></details>`,
    )
    .join("");
  return section(
    LABEL.detail,
    `<p class="intro">${esc(LABEL.detailIntro)}</p>${body}`,
    { id: "detail", cls: "heavy" },
  );
}

// ---------- configuration fit ----------

const findingItem = (f: FitFinding) =>
  `<li><code>config/${esc(f.id)}</code>${esc(f.message)}</li>`;

function findingGroups(fit: Fit): string {
  return (["error", "warning", "suggestion", "info"] as const)
    .map((sev) => {
      const rows = fit.findings.filter((f) => f.severity === sev);
      return rows.length === 0
        ? ""
        : `<h3 class="sev-h sev-${sev}">${esc(LABEL.severity[sev])} (${rows.length})</h3><ul class="fl">${rows.map(findingItem).join("")}</ul>`;
    })
    .join("");
}

function fitExtras(fit: Fit): string {
  const facts = Object.entries(fit.facts);
  const parts: string[] = [];
  if (facts.length > 0)
    parts.push(
      `<h3 class="sev-h">${esc(LABEL.facts)}</h3><dl class="kv">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`,
    );
  if (fit.declined.length > 0)
    parts.push(
      `<h3 class="sev-h">${esc(LABEL.declinedFindings)} (${fit.declined.length})</h3><ul class="fl">${fit.declined.map((d) => `<li><code>config/${esc(d.finding.id)}</code>${esc(d.reason)} ${esc(LABEL.revisitWhen)} ${esc(d.revisit_when)}</li>`).join("")}</ul>`,
    );
  if (fit.draft)
    parts.push(
      `<h3 class="sev-h">${esc(LABEL.draft)}</h3><p class="intro">${esc(LABEL.draftIntro)}</p><pre class="draft" id="draft">${esc(fit.draft)}</pre><p data-js hidden><button type="button" class="btn btn-q" data-copy="draft">${esc(SHEET_LABEL.copyDraft)}</button> <span class="done" role="status"></span></p>`,
    );
  return parts.join("");
}

function configSection(fit: Fit | null): string {
  if (!fit)
    return section(LABEL.config, `<p>${esc(LABEL.noFit)}</p>`, {
      id: "config",
      cls: "heavy",
    });
  const head = `<dl class="kv"><dt>${esc(LABEL.configFile)}</dt><dd><code>${esc(fit.file)}</code></dd><dt>${esc(LABEL.forge)}</dt><dd>${esc(fit.forge)}</dd></dl>${fit.configured ? "" : `<p>${esc(LABEL.configNone)}</p>`}`;
  const clean = fit.findings.every((f) => f.severity === "info")
    ? `<p class="ok">${esc(LABEL.nothingToFix)}</p>`
    : "";
  return section(
    LABEL.config,
    head + clean + findingGroups(fit) + fitExtras(fit),
    { id: "config", cls: "heavy" },
  );
}

// ---------- drift, examined, terms ----------

function driftSection(ctx: Ctx): string {
  const rich = richIn(ctx);
  const drift = ctx.input.source.drift ?? [];
  const body = drift.length
    ? `<ol class="claims">${drift.map((x) => `<li class="pair"><p class="main">${rich(x.text)}</p><p class="src"><span class="vh">${esc(LABEL.evidence)} </span>${x.evidence.map((e) => `<code>${esc(e)}</code>`).join("<br>")}</p></li>`).join("")}</ol>`
    : `<p>${esc(LABEL.noDrift)}</p>`;
  return section(
    LABEL.drift,
    `<p class="intro">${esc(LABEL.driftIntro)}</p>${body}`,
    { id: "drift" },
  );
}

function examinedSection(ctx: Ctx): string {
  const rich = richIn(ctx);
  const { stack, examined } = ctx.input.source;
  const table = `<h3 class="sub">${esc(LABEL.stack)}</h3><table class="stack"><thead><tr><th>${esc(LABEL.facet)}</th><th>${esc(LABEL.detected)}</th><th>${esc(LABEL.evidence)}</th></tr></thead><tbody>${stack.map((s) => `<tr><td>${esc(s.facet)}</td><td>${rich(s.detected)}</td><td><code>${esc(s.evidence)}</code></td></tr>`).join("")}</tbody></table>`;
  const read = `<h3 class="sub">${esc(LABEL.read)}</h3><ul class="plain">${examined.read.map((r) => `<li>${rich(r)}</li>`).join("")}</ul>`;
  const unchecked = examined.unchecked?.length
    ? `<h3 class="sub">${esc(LABEL.unchecked)}</h3><ul class="plain">${examined.unchecked.map((u) => `<li><b>${esc(u.what)}</b>: ${rich(u.why)}</li>`).join("")}</ul>`
    : "";
  const method = `<h3 class="sub">${esc(LABEL.method)}</h3><p class="intro">${esc(LABEL.methodText)} ${extLink(LADDER_URL, LABEL.ladderLink)}.</p>`;
  return section(LABEL.examined, table + read + unchecked + method, {
    id: "examined",
    cls: "heavy",
  });
}

// ---------- the tray and the page ----------

function tray(): string {
  return `<aside class="tray" id="tray" hidden aria-label="${esc(SHEET_LABEL.trayLabel)}"><div class="tray-in"><h2>${esc(SHEET_LABEL.trayLabel)}</h2><p class="counts"></p><div class="tray-acts"><button type="button" class="btn btn-q" data-act="show" aria-expanded="false" aria-controls="preview">${esc(SHEET_LABEL.showText)}</button><button type="button" class="btn" data-act="copy">${esc(SHEET_LABEL.copy)}</button><span class="done" role="status"></span><button type="button" class="clr" data-act="reset">${esc(SHEET_LABEL.reset)}</button></div><p class="miss" hidden></p><pre class="preview" id="preview" tabindex="0" hidden></pre></div></aside>`;
}

/** The sections in reading order, each with its entry in the bar; an empty slot is left out. */
function sections(input: ReportInput): [string, string, string][] {
  const targets = targetsOf(input);
  const ctx: Ctx = {
    input,
    targets,
    rows: mapRows(input, targets),
    inline: createInline({ glossary: input.source.terms ?? [], teamKey: "" }),
  };
  const comparison = sinceLast(input);
  const N = SHEET_LABEL.nav;
  const out: [string, string, string][] = [
    ["", "", masthead(ctx)],
    ["summary", N.summary, inShort(ctx)],
    ["map", N.map, mapSection(ctx)],
    ["start", N.start, startSection(ctx)],
  ];
  if (comparison) out.push(["since", N.since, sinceSection(input, comparison)]);
  if (input.source.recommendations.length > 0)
    out.push(["recs", N.recs, recsSection(ctx)]);
  out.push(
    ["detail", N.detail, detailSection(ctx.rows)],
    ["config", N.config, configSection(input.fit)],
    ["drift", N.drift, driftSection(ctx)],
    ["examined", N.examined, examinedSection(ctx)],
  );
  if (input.source.terms?.length)
    out.push([
      "terms",
      N.terms,
      section(LABEL.terms, termList(input.source.terms, ctx.inline.termIds), {
        id: "terms",
      }),
    ]);
  return out;
}

/** Render the audit sheet. The input must have passed `inputProblems`. */
export function renderReportHtml(input: ReportInput): string {
  const parts = sections(input);
  const nav = parts
    .filter(([id]) => id !== "")
    .map(([id, label]) => navItem(id, label));
  const main = `<main class="sheet" id="top">${parts.map(([, , html]) => html).join("")}</main>`;
  return page({
    title: `${LABEL.titleOf} ${input.source.repository.name} (${input.record.date})`,
    css: REPORT_CSS,
    body:
      topBar({ id: LABEL.sheet, navLabel: SHEET_LABEL.navContents, nav }) +
      main +
      tray(),
    source: { id: DATA_BLOCK_ID, value: embeddedData(input) },
    script: REPORT_SCRIPT,
  });
}

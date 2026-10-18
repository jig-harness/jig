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
 * and "optional", each saying why. A gap no recommendation covers carries a
 * second mark and is listed under the recommendations, so each gap is either
 * addressed or visibly left; the gaps the report leaves on purpose are
 * listed with their reasons. A recommendation applied since the audited
 * commit shows where, and offers no choice. Facts suggesting the team
 * revisit its profile, and another profile the facts support, sit beside
 * the profile in the summary, never among the findings. A criterion the
 * audit did not examine is shown as such, never as a gap.
 *
 * Every criterion's mark in the map, and every module's chip wherever a
 * module is named, carries a popover that explains it in plain words; the
 * words of the method link to the guide, the page's last section, which the
 * script turns into a view of its own. A first audit opens with a welcome
 * that points to the guide; a re-audit with a short link to how to read it.
 *
 * The page is self-contained and reads without JavaScript and in print: the
 * choices, the profile selector with its conditional targets, the flags on
 * each criterion's score, the copy buttons and the tray are rendered hidden
 * (`data-js`) and the script shows them; the folded groups render open and
 * the script folds them. It embeds everything it was rendered from in one
 * JSON block, so `report.ts extract` recovers the source, the record, the fit
 * report, the prior record and the history records from the file.
 */
import {
  esc,
  extLink,
  NAV_SEPARATOR,
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
import { LEVELS, meets, NOT_EXAMINED } from "../lib/criteria.ts";
import type { Conditional } from "../lib/profiles.ts";
import type { Comparison } from "../lib/record.ts";
import { cellsLabel, legend, mark } from "./cells.ts";
import { REPORT_CSS } from "./css.ts";
import { DATA_BLOCK_ID, embeddedData } from "./data.ts";
import { CHOICES } from "./feedback-text.ts";
import { guideSection } from "./guide.ts";
import { GUIDE_ID } from "./guide-text.ts";
import { LABEL, plural, SHEET_LABEL } from "./labels.ts";
import { iconSprite } from "./lucide/icons.ts";
import { critAnchor, createMarks, type Marks, scoreChip } from "./marks.ts";
import {
  alternativeOf,
  alternativeStanding,
  attainedWord,
  type Cell,
  countsOf,
  criteriaHeadline,
  groups,
  type Horizon,
  horizonWhy,
  isApplied,
  leftOnPurpose,
  mapRows,
  type ModuleRow,
  moduleTitle,
  movedCriteria,
  type ReportInput,
  recsFor,
  sinceLast,
  startHere,
  type Targets,
  targetsOf,
  uncoveredGaps,
  worthWhen,
} from "./model.ts";
import { REPORT_SCRIPT } from "./script.ts";
import { sinceBody } from "./since-html.ts";
import type { Fit, FitFinding, Recommendation } from "./source.ts";

/** The principle behind the ladder, in Jig's own repository. */
const LADDER_URL =
  "https://github.com/jig-harness/jig/blob/main/principles/04-enforcement-ladder.md";

type Rich = (text: string) => string;

/** What every section reads: the input, the targets, the map rows, the term linker and the marks. */
interface Ctx {
  input: ReportInput;
  targets: Targets;
  rows: ModuleRow[];
  inline: Inline;
  marks: Marks;
}

/** A fresh region for term links: each term links at its first use in a section. */
function richIn(ctx: Ctx): Rich {
  const seen = new Set<string>();
  return (text) => ctx.inline.textHtml(text, seen);
}

const codes = (items: readonly string[]) =>
  `<ul class="ev">${items.map((e) => `<li><code>${esc(e)}</code></li>`).join("")}</ul>`;
const lvClass = (row: ModuleRow) =>
  row.attained === "none" ||
  row.attained === "n/a" ||
  row.attained === "not-examined"
    ? "lv lv-none"
    : "lv";

// ---------- masthead and summary ----------

function profileHtml(t: Targets): string {
  if (!t.profile) return esc(LABEL.noProfile);
  const signals = t.profile.signals.length
    ? ` <a class="sig-l" href="#signals">${esc(LABEL.signalsLink)}</a>`
    : "";
  return `${esc(t.profile.name)} <span class="pchip p-${t.profile.source}">${esc(LABEL[t.profile.source])}</span>${signals}`;
}

function masthead(ctx: Ctx): string {
  const { source, record } = ctx.input;
  const name = source.repository.url
    ? extLink(source.repository.url, source.repository.name)
    : esc(source.repository.name);
  const { marks } = ctx;
  const meta: [string, string, string][] = [
    [esc(LABEL.audited), esc(record.date), ""],
    [
      esc(LABEL.commit),
      esc(record.commit.slice(0, 7)),
      ` class="mono" title="${esc(record.commit)}"`,
    ],
    [esc(LABEL.plugin), esc(record.plugin_version), ""],
    [marks.term("profile", LABEL.profile), profileHtml(ctx.targets), ""],
  ];
  if (ctx.targets.heading)
    meta.push([
      marks.term("heading", LABEL.headingTo),
      esc(ctx.targets.heading.name),
      "",
    ]);
  if (record.shape) meta.push([esc(LABEL.shape), esc(record.shape), ""]);
  const dl = meta
    .map(([dt, dd, attr]) => `<div><dt>${dt}</dt><dd${attr}>${dd}</dd></div>`)
    .join("");
  return `<header class="sec mast"><p class="lab mast-id">${esc(LABEL.sheet)}<span>${esc(record.date)}</span></p><div class="body"><h1>${esc(LABEL.titleOf)} ${name}</h1><dl class="meta">${dl}</dl>${welcome(ctx)}</div></header>`;
}

/**
 * The way into the guide: on a first audit a welcome saying what the sheet
 * is, for a reader who may never have met Jig; on a re-audit, whose readers
 * have seen one before, a short link.
 */
function welcome(ctx: Ctx): string {
  if (ctx.input.prior)
    return `<p class="howto"><a href="#${GUIDE_ID.read}">${esc(SHEET_LABEL.howToRead)}</a></p>`;
  const text = SHEET_LABEL.welcome.replace(
    "{repo}",
    ctx.input.source.repository.name,
  );
  return `<div class="welcome" id="welcome"><p>${esc(text)}</p><p><a href="#${GUIDE_ID.guide}">${esc(SHEET_LABEL.readGuide)}</a></p></div>`;
}

function stats(ctx: Ctx): string {
  const n = countsOf(ctx.input, ctx.rows, ctx.targets);
  const of = (a: number, b: number) =>
    `<span class="big">${a} <small>${esc(LABEL.ofWord)} ${b}</small></span>`;
  const later = n.later > 0 ? `; ${n.later} ${esc(LABEL.laterCount)}` : "";
  const head = criteriaHeadline(n);
  const applied =
    n.applied > 0 ? `; ${n.applied} ${esc(LABEL.appliedCount)}` : "";
  const items = [
    `<li class="met">${of(n.met, n.applicable)}${esc(head.noun)}${esc(head.tail)}</li>`,
    `<li><span class="big">${n.now}</span>${esc(LABEL.recommendationsNow[plural(n.now)])}, ${n.quickWins} ${esc(LABEL.quickWins[plural(n.quickWins)])}${later}${applied}</li>`,
  ];
  if (n.withTarget > 0)
    items.push(
      `<li>${of(n.atTarget, n.withTarget)}${esc(LABEL.modulesAtTarget[plural(n.withTarget)])}</li>`,
    );
  if (n.uncovered > 0)
    items.push(
      `<li class="unc-n"><a class="big" href="#uncovered">${n.uncovered}</a>${esc(LABEL.uncoveredCount[plural(n.uncovered)])}</li>`,
    );
  if (n.left > 0)
    items.push(
      `<li><a class="big" href="#left">${n.left}</a>${esc(LABEL.leftCount[plural(n.left)])}</li>`,
    );
  return `<ul class="stats">${items.join("")}</ul>`;
}

/** The facts that suggest revisiting the profile: beside the profile, in the team's own terms, never a finding. */
function signalsHtml(ctx: Ctx, rich: Rich): string {
  const signals = ctx.targets.profile?.signals ?? [];
  if (signals.length === 0) return "";
  const items = signals
    .map(
      (s) =>
        `<li><p>${rich(s.text)}</p><p class="src"><span class="vh">${esc(LABEL.evidence)} </span>${s.evidence.map((e) => `<code>${esc(e)}</code>`).join(" ")}</p></li>`,
    )
    .join("");
  return `<div class="signals" id="signals"><h3>${esc(LABEL.signalsHead)}</h3><p class="intro">${esc(LABEL.signalsIntro)}</p><ul>${items}</ul></div>`;
}

/** Another profile the facts support, with why and how the modules would stand under it: beside the profile, so the dial is chosen knowingly. */
function alternativeHtml(ctx: Ctx, rich: Rich): string {
  const alt = alternativeOf(ctx.input, ctx.targets);
  if (!alt) return "";
  const why = alt.why.map((w) => `<li>${rich(w)}</li>`).join("");
  const at = alternativeStanding(alt);
  return `<div class="alt" id="alternative"><h3>${esc(LABEL.alternativeHead.replace("{profile}", alt.name))}</h3>${why ? `<ul>${why}</ul>` : ""}<p>${esc(at)}</p></div>`;
}

function inShort(ctx: Ctx): string {
  const rich = richIn(ctx);
  const why = ctx.targets.profile?.why
    ? `<p class="why"><b>${esc(LABEL.whySuggested)}</b> ${rich(ctx.targets.profile.why)}</p>`
    : "";
  return section(
    LABEL.inShort,
    `<div class="main"><p class="lead">${rich(ctx.input.source.summary)}</p>${why}${alternativeHtml(ctx, rich)}${signalsHtml(ctx, rich)}</div><aside class="side">${stats(ctx)}</aside>`,
    { id: "summary", pair: true },
  );
}

// ---------- the maturity map ----------

/** Which bracket a level's marks sit over: the target's, the heading-to profile's, or none. */
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
    return `<span class="${groupClass(row, i)}">${own.map(mark).join("")}</span>`;
  }).join("");
  return `<div class="cells" role="group" aria-label="${esc(cellsLabel(row))}">${groupsHtml}</div>`;
}

function levelCell(row: ModuleRow, t: Targets): string {
  const parts = [
    `<span class="${lvClass(row)}">${esc(attainedWord(row.attained))}</span>`,
  ];
  if (row.target !== null) {
    parts.push(
      `<span class="tgt">${esc(LABEL.target)}: ${esc(LABEL.levelWord[row.target])}</span>`,
      row.missing === 0 && row.unexamined === 0
        ? `<span class="ok">${esc(LABEL.atTarget)}</span>`
        : row.missing > 0
          ? `<span class="go">${row.missing} ${esc(LABEL.toGo)}</span>`
          : "",
    );
    if (row.unexamined > 0)
      parts.push(
        `<span class="tgt">${row.unexamined} ${esc(LABEL.notExaminedHere)}</span>`,
      );
  } else if (t.now && !row.naReason)
    parts.push(`<span class="tgt">${esc(LABEL.notNeeded)}</span>`);
  if (row.heading !== null)
    parts.push(
      `<span class="tgt hd">${esc(LABEL.headingTo)}: ${esc(LABEL.levelWord[row.heading])}</span>`,
    );
  return `<div class="mlev">${parts.join("")}</div>`;
}

function mapRow(row: ModuleRow, ctx: Ctx): string {
  const name = row.title.slice(row.module.module.length + 1);
  const na = row.naReason
    ? `<p class="na-why">${esc(LABEL.notApplicable)} ${esc(row.naReason)}</p>`
    : "";
  return `<li class="mrow${row.naReason ? " na" : ""}" id="map-${esc(row.module.module)}"><div><p class="mname">${ctx.marks.chip(row.module.module)}${esc(name)}</p><p class="mpur">${esc(row.module.purpose)}</p>${na}</div>${levelCell(row, ctx.targets)}${cells(row)}</li>`;
}

/**
 * Each profile's conditional targets as checkboxes, checked as the record
 * has them, and after them those only the heading-to profile has, which the
 * record holds for it; the script shows the boxes of the profile that will
 * apply.
 */
function conditionsPicker(input: ReportInput, marks: Marks): string {
  const record = input.record.profile_conditions ?? [];
  const heading = input.record.heading_to
    ? input.profiles.profiles.get(input.record.heading_to)
    : undefined;
  const names = new Map(
    input.modules.map((m) => [
      m.module,
      moduleTitle(m).slice(m.module.length + 1),
    ]),
  );
  const box = (m: string, c: Conditional, ahead = "") =>
    `<label class="cond"><input type="checkbox" value="${esc(m)}"${record.includes(m) ? " checked" : ""}><span>${marks.chip(m, false)} <b>${esc(names.get(m) ?? "")}</b> (${esc(LABEL.levelWord[c.level])})${ahead ? ` ${esc(SHEET_LABEL.forHeading.replace("{profile}", ahead))}` : ""} ${esc(SHEET_LABEL.appliesWhen)} ${esc(c.when)}</span></label>`;
  return [...input.profiles.profiles.values()]
    .map((p) => {
      const ahead = heading
        ? [...heading.conditional].filter(([m]) => !p.conditional.has(m))
        : [];
      const boxes = [
        ...[...p.conditional].map(([m, c]) => box(m, c)),
        ...ahead.map(([m, c]) => box(m, c, heading?.name)),
      ].join("");
      return `<fieldset class="conds" data-prof="${esc(p.id)}" hidden><legend>${marks.phrase(SHEET_LABEL.conditionsHead, ["Conditional targets", "conditional"])}</legend>${boxes}</fieldset>`;
    })
    .join("");
}

function profilePicker(input: ReportInput, marks: Marks): string {
  const declared = input.record.profile
    ? input.profiles.profiles.get(input.record.profile)?.name
    : undefined;
  const options = [
    `<option value="">${esc(SHEET_LABEL.profileKeep)}: ${esc(declared ?? LABEL.noProfile)}</option>`,
    ...[...input.profiles.profiles.values()].map(
      (p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`,
    ),
  ];
  return `<div class="psel" data-js hidden><p class="psel-p"><label for="profile-pick">${esc(SHEET_LABEL.profileChange)}</label><select id="profile-pick">${options.join("")}</select></p>${conditionsPicker(input, marks)}</div>`;
}

function mapSection(ctx: Ctx): string {
  const { marks } = ctx;
  const levelHead = marks.phrase(
    SHEET_LABEL.levelAndTarget,
    ["Level", "level"],
    ["target", "target"],
  );
  const head = `<div class="mhead"><span>${marks.term("module", LABEL.module)}</span><span>${levelHead}</span><span>${esc(LABEL.criteria)}</span></div>`;
  const intro = `<p class="intro">${esc(LABEL.mapIntro)} ${marks.phrase(SHEET_LABEL.mapMarks, ["enforcement ladder", "ladder"])}</p>`;
  return section(
    LABEL.map,
    `${intro}${legend(ctx.targets, marks)}${head}<ol class="mmap">${ctx.rows.map((r) => mapRow(r, ctx)).join("")}</ol>${profilePicker(ctx.input, marks)}`,
    { id: "map" },
  );
}

// ---------- recommendations ----------

/** Where a recommendation was applied: a link to the pull request, its number, or the commit. */
function appliedWhere(at: string): string {
  if (at.startsWith("https://")) return extLink(at, at);
  if (/^#?\d+$/.test(at)) return esc(at.startsWith("#") ? at : `#${at}`);
  return `<code>${esc(at.slice(0, 7))}</code>`;
}

function tags(r: Recommendation): string {
  const done =
    isApplied(r) && r.applied_in
      ? `<span class="tag tag-done">${esc(LABEL.appliedIn)} ${appliedWhere(r.applied_in)}</span>`
      : "";
  const needs = r.needs
    ? `<span class="tag tag-admin">${esc(LABEL.needs[r.needs])}</span>`
    : "";
  return `<div class="tags">${done}<span class="tag">${esc(LABEL.leverage)} <b>${esc(LABEL.leverageWord[r.leverage])}</b></span><span class="tag">${esc(LABEL.effort)} <b>${esc(LABEL.effortWord[r.effort])}</b></span>${r.quick_win ? `<span class="tag tag-qw">${esc(LABEL.quickWin)}</span>` : ""}${needs}</div>`;
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

function moved(input: ReportInput, r: Recommendation, marks: Marks): string {
  const requires = new Map(
    input.modules.flatMap((m) => m.criteria.map((c) => [c.key, c.requires])),
  );
  return `<ul class="mv">${movedCriteria(r, input.record)
    .map((m) => {
      const bar = requires.get(m.ref);
      return `<li>${marks.ref(m.ref)}${bar ? `${scoreChip(m.score)}<span class="tgt">${esc(LABEL.requires)} ${esc(bar)}</span>` : ""}</li>`;
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
    [LABEL.moves, moved(ctx.input, r, ctx.marks)],
  );
  const when = horizon === "now" ? null : worthWhen(r, ctx.input, ctx.targets);
  if (when) fields.push([LABEL.worthWhen, rich(when)]);
  const dl = fields
    .map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${dd}</dd>`)
    .join("");
  // An applied recommendation is done: it takes no decision, so it offers no choice.
  const head = isApplied(r)
    ? `<article class="rec done" id="rec-${esc(r.id)}">`
    : `<article class="rec" id="rec-${esc(r.id)}" data-rec="${esc(r.id)}">`;
  return `<li>${head}<div class="rec-h"><span class="rid">${esc(r.id)}</span><h4>${esc(r.title)}</h4></div>${tags(r)}<dl class="fields">${dl}</dl>${isApplied(r) ? "" : choices(r)}</article></li>`;
}

/** A group's heading: a module's chip and name, or the configuration's title. */
const groupTitle = (ctx: Ctx, g: { id: string; title: string }) =>
  g.title.startsWith(`${g.id} `)
    ? `${ctx.marks.chip(g.id)}${esc(g.title.slice(g.id.length + 1))}`
    : esc(g.title);

function groupsHtml(
  ctx: Ctx,
  recs: Recommendation[],
  horizon: Horizon,
  rich: Rich,
): string {
  return groups(ctx.input, recs)
    .map(
      (g) =>
        `<h3 class="grp-h" id="g-${horizon}-${esc(g.id)}">${groupTitle(ctx, g)}</h3><p class="grp-p">${esc(g.purpose)}</p><ol class="recs">${g.recs.map((r) => card(ctx, r, horizon, rich)).join("")}</ol>`,
    )
    .join("");
}

/** A later horizon: open as rendered, folded by the script, with why it is not for now. */
function laterGroup(ctx: Ctx, horizon: Horizon, rich: Rich): string {
  const recs = recsFor(horizon, ctx.input, ctx.targets);
  if (recs.length === 0) return "";
  const why = ctx.marks.phrase(horizonWhy(horizon, ctx.targets), [
    ctx.targets.profile?.name ?? "",
    "profile",
  ]);
  return `<details class="later" id="h-${horizon}" open data-fold><summary><span class="later-h">${esc(LABEL.horizon[horizon])}</span> <span class="later-n">(${recs.length})</span></summary><p class="intro">${why}</p>${groupsHtml(ctx, recs, horizon, rich)}</details>`;
}

/** The gaps within the target that no recommendation moves, so each is either addressed or left on purpose. */
function uncoveredList(rows: readonly ModuleRow[], marks: Marks): string {
  const cells = uncoveredGaps(rows);
  if (cells.length === 0) return "";
  const items = cells
    .map(
      (c) =>
        `<li>${marks.ref(c.criterion.key)} ${esc(c.criterion.statement)}</li>`,
    )
    .join("");
  return `<div class="uncov" id="uncovered"><h3 class="sev-h">${esc(LABEL.uncoveredHead)} (${cells.length})</h3><p class="intro">${marks.phrase(LABEL.uncoveredIntro, ["target", "target"])}</p><ul class="fl">${items}</ul></div>`;
}

/** What the report leaves on purpose: each entry's criteria, its reason and when to look again. */
function leftList(ctx: Ctx): string {
  const left = leftOnPurpose(ctx.input);
  if (left.length === 0) return "";
  const rich = richIn(ctx);
  const items = left
    .map(
      (l) =>
        `<li>${l.refs.map(ctx.marks.ref).join(" ")}<span class="lr">${rich(l.reason)}</span>${l.revisit_when ? `<span class="lw">${esc(LABEL.revisitWhen)} ${rich(l.revisit_when)}</span>` : ""}</li>`,
    )
    .join("");
  return `<div class="left" id="left"><h3 class="sev-h">${esc(LABEL.leftHead)} (${left.flatMap((l) => l.refs).length})</h3><p class="intro">${ctx.marks.phrase(LABEL.leftIntro, ["target", "target"])}</p><ul class="fl">${items}</ul></div>`;
}

function recsSection(ctx: Ctx): string {
  const rich = richIn(ctx);
  const now = recsFor("now", ctx.input, ctx.targets);
  const none =
    ctx.input.source.recommendations.length === 0
      ? `<p>${esc(LABEL.noRecommendations)}</p>`
      : "";
  const body =
    none +
    groupsHtml(ctx, now, "now", rich) +
    uncoveredList(ctx.rows, ctx.marks) +
    leftList(ctx) +
    laterGroup(ctx, "grow", rich) +
    laterGroup(ctx, "optional", rich);
  return section(LABEL.recommendations, body, { id: "recs", cls: "heavy" });
}

// ---------- since the last audit ----------

function sinceSection(ctx: Ctx, c: Comparison): string {
  return section(
    LABEL.since,
    sinceBody(ctx.input, c, ctx.rows, ctx.targets, ctx.marks),
    { id: "since" },
  );
}

// ---------- module detail ----------

/** Where a criterion stands against the profile: needed and not met, or not needed and not met. */
function standing(c: Cell): string {
  if (c.score === NOT_EXAMINED) return "";
  const uncovered = c.uncovered
    ? `<span class="unct">${esc(LABEL.uncoveredLegend)}</span>`
    : "";
  const left = c.left ? `<span class="nn">${esc(LABEL.leftLegend)}</span>` : "";
  if (c.gap)
    return `<span class="gapt">${esc(LABEL.gapLegend)}</span>${uncovered}${left}`;
  const met = c.score !== null && meets(c.score, c.criterion.requires);
  return c.inTarget === false && !met
    ? `<span class="nn">${esc(LABEL.notNeeded)}</span>`
    : "";
}

/** Flagging a criterion's score as wrong, with the note it needs: hidden until the script runs. */
const scoreFlag = () =>
  `<div class="sw" data-js hidden><label class="swl"><input type="checkbox" data-sw><span>${esc(SHEET_LABEL.scoreWrong)}</span></label><label class="swn" hidden>${esc(SHEET_LABEL.note)}<textarea data-swn rows="2"></textarea></label></div>`;

function criterionItem(c: Cell): string {
  const by = c.decidedBy === "probe" ? LABEL.byProbe : LABEL.byAgent;
  return `<li data-crit="${esc(c.criterion.key)}" id="${esc(critAnchor(c.criterion.key))}"><div><p class="cid">${esc(c.criterion.id)}</p><p class="stm">${esc(c.criterion.statement)}</p></div><div class="chips"><span>${esc(LABEL.levelWord[c.criterion.level])}</span><span>${esc(LABEL.requires)} ${esc(c.criterion.requires)}</span>${scoreChip(c.score)}${standing(c)}</div><p class="cev"><b>${esc(LABEL.decidedBy)} ${esc(by)}.</b> ${esc(c.evidence ?? "")}</p>${scoreFlag()}</li>`;
}

function detailSection(ctx: Ctx): string {
  const { marks } = ctx;
  const body = ctx.rows
    .map(
      (row) =>
        // Open in the file, so the detail reads without a script and in print;
        // the script folds it like the later recommendations.
        `<details class="mod" open data-fold><summary><h3 class="mod-h" id="d-${esc(row.module.module)}">${marks.chip(row.module.module, false)}${esc(row.title.slice(row.module.module.length + 1))}<span class="${lvClass(row)}">${esc(attainedWord(row.attained))}</span></h3></summary><ol class="crit">${row.cells.map(criterionItem).join("")}</ol></details>`,
    )
    .join("");
  const intro = marks.phrase(
    LABEL.detailIntro,
    ["level", "level"],
    ["probe", "probe"],
  );
  return section(LABEL.detail, `<p class="intro">${intro}</p>${body}`, {
    id: "detail",
    cls: "heavy",
  });
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
    ? `<ol class="claims">${drift.map((x) => `<li class="pair"><p class="main">${isApplied(x) && x.applied_in ? `<span class="tag tag-done">${esc(LABEL.fixedIn)} ${appliedWhere(x.applied_in)}</span> ` : ""}${rich(x.text)}</p><p class="src"><span class="vh">${esc(LABEL.evidence)} </span>${x.evidence.map((e) => `<code>${esc(e)}</code>`).join("<br>")}</p></li>`).join("")}</ol>`
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
    marks: createMarks(input.modules),
  };
  const comparison = sinceLast(input);
  const N = SHEET_LABEL.nav;
  const out: [string, string, string][] = [
    ["", "", masthead(ctx)],
    ["summary", N.summary, inShort(ctx)],
    ["map", N.map, mapSection(ctx)],
    ["start", N.start, startSection(ctx)],
  ];
  if (comparison) out.push(["since", N.since, sinceSection(ctx, comparison)]);
  if (
    input.source.recommendations.length > 0 ||
    uncoveredGaps(ctx.rows).length > 0 ||
    leftOnPurpose(input).length > 0
  )
    out.push(["recs", N.recs, recsSection(ctx)]);
  out.push(
    ["detail", N.detail, detailSection(ctx)],
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
  out.push([
    GUIDE_ID.guide,
    N.guide,
    guideSection({
      modules: input.modules,
      profiles: input.profiles,
      hasTerms: (input.source.terms?.length ?? 0) > 0,
      marks: ctx.marks,
    }),
  ]);
  return out;
}

/** Render the audit sheet. The input must have passed `inputProblems`. */
export function renderReportHtml(input: ReportInput): string {
  const parts = sections(input);
  // The guide stands apart from the report's sections, after a separator.
  const nav = parts
    .filter(([id]) => id !== "")
    .map(([id, label]) =>
      id === GUIDE_ID.guide
        ? NAV_SEPARATOR + navItem(id, label)
        : navItem(id, label),
    );
  const main = `<main class="sheet" id="top">${parts.map(([, , html]) => html).join("")}</main>`;
  return page({
    title: `${LABEL.titleOf} ${input.source.repository.name} (${input.record.date})`,
    css: REPORT_CSS,
    body:
      iconSprite() +
      topBar({ id: LABEL.sheet, navLabel: SHEET_LABEL.navContents, nav }) +
      main +
      tray(),
    source: { id: DATA_BLOCK_ID, value: embeddedData(input) },
    script: REPORT_SCRIPT,
  });
}

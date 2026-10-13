/**
 * "Since the last audit" in the sheet: the counts as a row of coloured
 * badges, then one table per kind of standing (what changed, what is still
 * open within the target, and, folded, what is still open beyond it). Each
 * row is a criterion: its module's chip, its id linked to its detail, its
 * score before and after as score chips, and the change as a badge whose
 * colour says good (fixed), bad (regressed), neutral (reclassified), new
 * (new, added by Jig), to do (still open within the target) or quiet
 * (removed, beyond the target). The levels that changed, or the trend across
 * older records, follow in the same table style, then the declined
 * recommendations.
 */
import { esc } from "../../../decide/scripts/sheet-kit/html.ts";
import type { Comparison, CriterionChange } from "../lib/record.ts";
import { LABEL, SHEET_LABEL } from "./labels.ts";
import { critAnchor, type Marks, scoreChip } from "./marks.ts";
import {
  levelChanges,
  type ModuleRow,
  type ReportInput,
  SHOWN_CHANGES,
  type StillOpen,
  stillOpenOf,
  type Targets,
  type Trend,
  type TrendRow,
  trendOf,
  trendSummary,
} from "./model.ts";

/** A badge's colour: one per kind of change, and the two kinds of still open. */
type BadgeKind =
  | (typeof SHOWN_CHANGES)[number]
  | "open"
  | "beyond"
  | "unchanged";

/** A badge's word, capitalised like the change kinds beside it. */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const badge = (kind: BadgeKind, text: string) =>
  `<span class="bd bd-${kind}">${esc(capital(text))}</span>`;

const countBadge = (kind: BadgeKind, text: string, n: number) =>
  `<li><span class="bd bd-${kind}">${esc(capital(text))} <b>${n}</b></span></li>`;

/** The counts, as badges: each kind of change with any rows, then what stayed open or met. */
function countRow(c: Comparison, open: StillOpen | null): string {
  const count = (change: string) =>
    c.criteria.filter((r) => r.change === change).length;
  const items = SHOWN_CHANGES.filter((k) => count(k) > 0).map((k) =>
    countBadge(k, LABEL.changes[k], count(k)),
  );
  if (open) {
    if (open.within.length)
      items.push(countBadge("open", LABEL.stillOpenHead, open.within.length));
    if (open.beyond.length)
      items.push(
        countBadge("beyond", LABEL.stillOpenBeyondHead, open.beyond.length),
      );
  } else if (count("still-open"))
    items.push(countBadge("open", LABEL.stillOpen, count("still-open")));
  if (count("unchanged"))
    items.push(countBadge("unchanged", LABEL.unchangedMet, count("unchanged")));
  return items.length ? `<ul class="bds">${items.join("")}</ul>` : "";
}

const scoreOrNone = (s: CriterionChange["prior"], none: boolean) =>
  none
    ? `<span class="nos" aria-hidden="true">—</span><span class="vh">${esc(SHEET_LABEL.noScore)}</span>`
    : scoreChip(s);

function changeRow(
  r: CriterionChange,
  kind: BadgeKind,
  word: string,
  marks: Marks,
): string {
  const [module, id] = r.key.split("/") as [string, string];
  const before = scoreOrNone(
    r.prior,
    r.prior === null && r.change !== "still-open",
  );
  const after = scoreOrNone(r.current, r.change === "removed");
  return `<tr><td>${marks.chip(module)}</td><td class="cc"><a href="#${esc(critAnchor(r.key))}"><code>${esc(id)}</code></a></td><td class="ba">${before}<span class="arr" aria-hidden="true">→</span><span class="vh"> ${esc(SHEET_LABEL.moveTo)} </span>${after}</td><td>${badge(kind, word)}</td></tr>`;
}

function changeTable(rows: string[]): string {
  return `<table class="chgt chg-t"><thead><tr><th scope="col">${esc(LABEL.module)}</th><th scope="col">${esc(LABEL.criterion)}</th><th scope="col">${esc(LABEL.beforeAfter)}</th><th scope="col">${esc(LABEL.change)}</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

/** Every criterion that changed, worst first, as one table. */
function changedTable(c: Comparison, marks: Marks): string {
  const rows = SHOWN_CHANGES.flatMap((k) =>
    c.criteria
      .filter((r) => r.change === k)
      .map((r) => changeRow(r, k, LABEL.changes[k], marks)),
  );
  if (rows.length === 0) return "";
  return `<h3 class="sev-h">${esc(LABEL.changedHead)} (${rows.length})</h3>${changeTable(rows)}`;
}

/** The criteria still open within the target, then those beyond it, both folded like the later recommendations: the counts above already say how many. */
function stillOpenTables(open: StillOpen | null, marks: Marks): string {
  if (!open) return "";
  const rows = (list: CriterionChange[], kind: BadgeKind, word: string) =>
    changeTable(list.map((r) => changeRow(r, kind, word, marks)));
  const within = open.within.length
    ? `<details class="later sm" id="since-within" open data-fold><summary><span class="later-h">${esc(LABEL.stillOpenHead)}</span> <span class="later-n">(${open.within.length})</span></summary>${rows(open.within, "open", LABEL.stillOpen)}</details>`
    : "";
  const beyond = open.beyond.length
    ? `<details class="later sm" id="since-beyond" open data-fold><summary><span class="later-h">${esc(LABEL.stillOpenBeyondHead)}</span> <span class="later-n">(${open.beyond.length})</span></summary><p class="intro">${esc(LABEL.stillOpenBeyondWhy.replace("{profile}", open.profile))}</p>${rows(open.beyond, "beyond", LABEL.stillOpen)}</details>`
    : "";
  return within + beyond;
}

const moduleCell = (id: string, title: string, marks: Marks) =>
  `<th scope="row">${marks.chip(id)} ${esc(title.slice(id.length + 1))}</th>`;

function levelTable(input: ReportInput, c: Comparison, marks: Marks): string {
  const changes = levelChanges(c, input.modules);
  if (changes.length === 0) return "";
  const rows = changes
    .map(
      (l) =>
        `<tr>${moduleCell(l.id, l.module, marks)}<td>${esc(l.prior)}</td>${moveCell({ word: l.current, move: l.move })}</tr>`,
    )
    .join("");
  return `<h3 class="sev-h">${esc(LABEL.levelsChanged)}</h3><table class="chgt lvt"><thead><tr><th scope="col">${esc(LABEL.module)}</th><th scope="col">${esc(LABEL.prior)}</th><th scope="col">${esc(LABEL.now)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function moveCell(l: TrendRow["levels"][number]): string {
  if (!l.move) return `<td>${esc(l.word)}</td>`;
  return `<td class="mv-${l.move}"><span aria-hidden="true">${LABEL.moveArrow[l.move]} </span><span class="vh">${esc(LABEL.moveWord[l.move])} </span>${esc(l.word)}</td>`;
}

/** Each module's level at every record, oldest first, for the modules whose level changed; it holds the prior record too. */
function trendTable(t: Trend, marks: Marks): string {
  const head = t.points
    .map(
      (p) =>
        `<th scope="col" title="${esc(p.commit)}">${p.current ? `${esc(LABEL.now)} ` : ""}${esc(p.date)}</th>`,
    )
    .join("");
  const rows = t.rows
    .map(
      (r) =>
        `<tr>${moduleCell(r.id, r.module, marks)}${r.levels.map(moveCell).join("")}</tr>`,
    )
    .join("");
  const table = rows
    ? `<div class="trend-w"><table class="chgt trend"><thead><tr><th scope="col">${esc(LABEL.module)}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
    : "";
  return `<h3 class="sev-h">${esc(LABEL.trend)}</h3><p class="trend-s">${esc(trendSummary(t))}</p><p class="intro">${esc(LABEL.trendIntro)}</p>${table}`;
}

function declinedList(c: Comparison, marks: Marks): string {
  if (c.declined.length === 0) return "";
  return `<h3 class="sev-h">${esc(LABEL.declinedHead)}</h3><ul class="fl">${c.declined.map((d) => `<li><b>${esc(LABEL.declinedStatus[d.status])}</b> ${d.entry.refs.map(marks.ref).join(" ")} ${esc(d.why)}</li>`).join("")}</ul>`;
}

/** The section's body: the comparison with the prior record, or that nothing changed. */
export function sinceBody(
  input: ReportInput,
  c: Comparison,
  rows: readonly ModuleRow[],
  targets: Targets,
  marks: Marks,
): string {
  const open = stillOpenOf(c, rows, targets);
  const intro = `<p class="intro">${esc(
    SHEET_LABEL.sinceCompared
      .replace("{date}", input.prior?.date ?? "")
      .replace("{version}", input.prior?.plugin_version ?? ""),
  )}</p>${countRow(c, open)}`;
  const trend = trendOf(input);
  // The trend holds the prior record's levels, so it takes the levels table's place.
  const levels = trend ? trendTable(trend, marks) : levelTable(input, c, marks);
  const body =
    changedTable(c, marks) +
    stillOpenTables(open, marks) +
    levels +
    declinedList(c, marks);
  return intro + (body || `<p>${esc(LABEL.noChange)}</p>`);
}

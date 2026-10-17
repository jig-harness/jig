/**
 * The maturity map's marks: one per criterion, its rung's icon on its rung's
 * colour, with the amber ring of a gap and the dot of a gap no
 * recommendation covers drawn over it; a gap left on purpose keeps its ring
 * and has no dot. Each mark links to its criterion in
 * Module detail and carries a popover that says, in plain words, what the
 * criterion asks, its level, its bar, its score and what the score means,
 * where it stands against the profile and who decided it. The legend draws
 * the same marks.
 */
import { esc } from "../../../decide/scripts/sheet-kit/html.ts";
import {
  EXPECTED_ABSENT,
  meets,
  NOT_EXAMINED,
  RUNGS,
} from "../lib/criteria.ts";
import { LABEL, plural, SHEET_LABEL } from "./labels.ts";
import {
  critAnchor,
  type Marks,
  rungClass,
  rungIcon,
  rungWord,
  scoreChip,
} from "./marks.ts";
import type { Cell, ModuleRow, Targets } from "./model.ts";
import { tally } from "./model.ts";

/** A mark's own marks: the gap ring, and the dot of a gap no recommendation covers. */
const markClass = (c: Cell) =>
  `${c.gap ? " gap" : ""}${c.uncovered ? " unc" : ""}`;

/** What a mark shows, for a reader who cannot see it. */
function markLabel(c: Cell): string {
  const parts = [`${c.criterion.id}: ${rungWord(c.score)}`];
  if (c.gap) parts.push(LABEL.gapLegend);
  if (c.uncovered) parts.push(LABEL.uncoveredLegend);
  if (c.left) parts.push(LABEL.leftLegend);
  return parts.join("; ");
}

type Standing = [cls: "gap" | "ok" | "nn", text: string];

/** Where a criterion stands against the profile, in the popover's words. */
function standing(c: Cell): Standing[] {
  const S = SHEET_LABEL.standing;
  if (c.score === EXPECTED_ABSENT) return [["nn", S.na]];
  if (c.score === NOT_EXAMINED) return [["nn", S.notExamined]];
  if (c.gap) {
    const out: Standing[] = [["gap", S.gap]];
    if (c.uncovered) out.push(["gap", S.uncovered]);
    if (c.left) out.push(["nn", `${S.left} ${c.left}`]);
    return out;
  }
  const met = c.score !== null && meets(c.score, c.criterion.requires);
  if (c.inTarget === true) return [["ok", S.withinMet]];
  if (c.inTarget === false) return [["nn", met ? S.beyondMet : S.notNeeded]];
  return [["nn", met ? S.met : S.notMet]];
}

function popover(c: Cell, id: string): string {
  const k = c.criterion;
  const P = SHEET_LABEL.pop;
  const meaning =
    c.score === null ? LABEL.notScoredMeaning : LABEL.rungMeaning[c.score];
  const bar = `${scoreChip(k.requires)}${k.requires === "convention" ? ` ${esc(P.orStronger)}` : ""}`;
  const by = c.decidedBy === "probe" ? LABEL.byProbe : LABEL.byAgent;
  const rows = [
    [LABEL.level, esc(LABEL.levelWord[k.level])],
    [P.requires, bar],
    [P.score, `${scoreChip(c.score)} ${esc(meaning)}`],
    [LABEL.decidedBy, esc(by)],
  ]
    .map(
      ([dt, dd]) =>
        `<span class="pc-k">${esc(dt as string)}</span><span>${dd}</span>`,
    )
    .join("");
  const lines = standing(c)
    .map(([cls, text]) => `<span class="pc-st st-${cls}">${esc(text)}</span>`)
    .join("");
  const module = k.key.split("/")[0] ?? "";
  return `<span class="pop pop-c" role="tooltip" id="${id}"><span class="pc-h"><span class="mchip">${esc(module)}</span><b>${esc(k.id)}</b></span><span class="pc-s">${esc(k.statement)}</span><span class="pc-kv">${rows}</span>${lines}</span>`;
}

/** One criterion's mark: a link to its detail, its popover beside it. */
export function mark(c: Cell): string {
  const anchor = critAnchor(c.criterion.key);
  const pid = `p-${anchor}`;
  return `<span class="pw cw-w"><a class="cw" href="#${esc(anchor)}" aria-describedby="${esc(pid)}"><span class="c c-${rungClass(c.score)}${markClass(c)}">${rungIcon(c.score)}</span><span class="vh">${esc(markLabel(c))}</span></a>${popover(c, esc(pid))}</span>`;
}

/** The marks of a module, for a reader who cannot see them: each rung with its count. */
export function cellsLabel(row: ModuleRow): string {
  const gaps = row.cells.filter((c) => c.gap).length;
  const uncovered = row.cells.filter((c) => c.uncovered).length;
  const parts = tally(row).map((t) => `${t.n} ${rungWord(t.score)}`);
  if (gaps > 0) parts.push(`${gaps} ${LABEL.gapLegend}`);
  if (uncovered > 0)
    parts.push(`${uncovered} ${LABEL.uncoveredCount[plural(uncovered)]}`);
  return `${row.module.module}: ${parts.join(", ")}`;
}

const tile = (cls: string, score: Parameters<typeof rungIcon>[0]) =>
  `<span class="c ${cls}" aria-hidden="true">${rungIcon(score)}</span>`;

/** The legend: every rung's mark, the gap's ring and dot, and the target's markers. */
export function legend(t: Targets, marks: Marks): string {
  const item = (mk: string, text: string) =>
    `<li>${mk}<span>${text}</span></li>`;
  const items = ([...RUNGS, EXPECTED_ABSENT, NOT_EXAMINED] as const).map((r) =>
    item(
      tile(`c-${r}`, r),
      `<b>${esc(LABEL.rung[r])}</b> ${esc(LABEL.rungMeaning[r])}`,
    ),
  );
  items.push(
    item(
      tile("c-unscored", null),
      `<b>${esc(LABEL.notScored)}</b> ${esc(LABEL.notScoredMeaning)}`,
    ),
  );
  if (t.now)
    items.push(
      item(tile("c-absent gap", "absent"), marks.term("gap", LABEL.gapLegend)),
      item(
        tile("c-absent gap unc", "absent"),
        marks.term("uncovered", LABEL.uncoveredLegend),
      ),
      item(
        '<span class="bracket" aria-hidden="true"></span>',
        marks.phrase(LABEL.withinTarget, ["target", "target"]),
      ),
    );
  if (t.heading)
    items.push(
      item(
        '<span class="bracket grow" aria-hidden="true"></span>',
        `${marks.phrase(LABEL.withinHeading, ["heading-to", "heading"])} (${esc(t.heading.name)})`,
      ),
    );
  return `<ul class="legend">${items.join("")}</ul>`;
}

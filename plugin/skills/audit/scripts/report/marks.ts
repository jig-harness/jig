/**
 * The small marks the audit sheet repeats: a rung's icon and score chip, a
 * module's chip with its popover, a criterion's reference, and a word of the
 * method linked to the guide with its meaning as a tip.
 *
 * A popover is a hidden element beside what it explains, shown by the
 * stylesheet on hover and on keyboard focus, so it works without
 * JavaScript; the script only keeps it inside the viewport. The popovers
 * repeat what the legend, the module detail and the guide already say, so
 * print leaves them out.
 *
 * One `Marks` per rendered sheet: the popovers' and tips' ids count up
 * across the sheet, from the same start on every render, so a sheet
 * rendered again from its embedded data is the same file.
 */
import { esc } from "../../../decide/scripts/sheet-kit/html.ts";
import type { Module, Score } from "../lib/criteria.ts";
import {
  METHOD_TERMS,
  type MethodTerm,
  type MethodTermKey,
} from "./guide-text.ts";
import { LABEL } from "./labels.ts";
import { icon, type IconName } from "./lucide/icons.ts";
import { moduleTitle } from "./model.ts";

/** A score's class: its rung, or `unscored` where the record has none. */
export type RungClass = Score | "unscored";

export const rungClass = (score: Score | null): RungClass =>
  score ?? "unscored";

export const rungWord = (score: Score | null) =>
  score === null ? LABEL.notScored : LABEL.rung[score];

/**
 * Each rung's icon, distinct in shape so the map reads without colour:
 * a dashed circle for nothing there, a page for written down, an eye for a
 * tool that watches, a shield for a check that blocks, a struck circle for
 * a practice the shape rules out, a question mark for no score.
 */
export const RUNG_ICON: Readonly<Record<RungClass, IconName>> = {
  absent: "circle-dashed",
  convention: "file-text",
  advisory: "eye",
  mechanical: "shield-check",
  "expected-absent": "circle-slash",
  unscored: "circle-question-mark",
};

export const rungIcon = (score: Score | null) =>
  icon(RUNG_ICON[rungClass(score)]);

/** A score as a chip: its icon and its word on the rung's colour. */
export const scoreChip = (score: Score | null) =>
  `<span class="sch s-${rungClass(score)}">${rungIcon(score)}${esc(rungWord(score))}</span>`;

/** The anchor of a criterion in Module detail. */
export const critAnchor = (key: string) => `c-${key.replace("/", "-")}`;

const CRITERION_REF = /^(M\d+)\/(.+)$/;

export interface Marks {
  /**
   * A module's chip with its popover: the module's name and purpose. It
   * links to the module's detail; inside a label or a summary, which must
   * not hold a link, it is a plain chip.
   */
  chip(module: string, link?: boolean): string;
  /** A criterion ref as the module's chip and the criterion's id, linked to its detail; any other ref as code. */
  ref(ref: string): string;
  /** A word of the method, linked to the guide section that explains it, with its meaning as a tip. */
  term(key: MethodTermKey, text?: string): string;
  /** `text` with the first use of each of `words` as that word of the method. */
  phrase(text: string, ...words: (readonly [string, MethodTermKey])[]): string;
}

export function createMarks(modules: readonly Module[]): Marks {
  const byId = new Map(modules.map((m) => [m.module, m]));
  let pops = 0;

  function chip(id: string, link = true): string {
    const m = byId.get(id);
    if (!m) return `<span class="mchip">${esc(id)}</span>`;
    const pid = `mp-${++pops}`;
    const face = link
      ? `<a class="mchip" href="#d-${esc(id)}" aria-describedby="${pid}">${esc(id)}</a>`
      : `<span class="mchip">${esc(id)}</span>`;
    return `<span class="pw mw">${face}<span class="pop pop-m" role="tooltip" id="${pid}"><b>${esc(moduleTitle(m))}</b> ${esc(m.purpose)}</span></span>`;
  }

  function ref(text: string): string {
    const m = CRITERION_REF.exec(text);
    if (!m || !byId.has(m[1] as string)) return `<code>${esc(text)}</code>`;
    return `<span class="cref">${chip(m[1] as string)} <a href="#${esc(critAnchor(text))}"><code>${esc(m[2] as string)}</code></a></span>`;
  }

  function term(key: MethodTermKey, text?: string): string {
    const t: MethodTerm = METHOD_TERMS[key];
    const tip = `gt-${++pops}`;
    return `<span class="tw"><a class="term" href="#${t.section}" aria-describedby="${tip}">${esc(text ?? t.term)}</a><span class="tip" role="tooltip" id="${tip}">${esc(t.meaning)}</span></span>`;
  }

  // The first word splits the text; the others are looked for on each side
  // of it, left to right, so the tips' ids follow the reading order.
  function phrase(
    text: string,
    ...words: (readonly [string, MethodTermKey])[]
  ): string {
    const [first, ...rest] = words;
    if (!first) return esc(text);
    const [word, key] = first;
    const at = word ? text.indexOf(word) : -1;
    if (at < 0) return phrase(text, ...rest);
    const before = phrase(text.slice(0, at), ...rest);
    const self = term(key, word);
    return before + self + phrase(text.slice(at + word.length), ...rest);
  }

  return { chip, ref, term, phrase };
}

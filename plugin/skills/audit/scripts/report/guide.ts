/**
 * The guide: what Jig is, the idea and the enforcement ladder, the modules,
 * the profiles, how the audit works, how to read the sheet and the words of
 * the method, for a reader who has never met Jig.
 *
 * It is one section of the page. Without JavaScript and in print it is the
 * last section, all of it visible; the script turns it into a view of its
 * own on the `#guide` route (`#guide-profiles` opens a part of it), hides the
 * report while it is open and returns to where the reader was.
 *
 * What can be derived is: the modules and their purposes come from the
 * criteria files, the targets from the profiles, the rungs' words from the
 * labels. Only the prose is fixed, in `guide-text.ts`.
 */
import {
  esc,
  extLink,
  section,
} from "../../../decide/scripts/sheet-kit/html.ts";
import {
  EXPECTED_ABSENT,
  type Module,
  NOT_EXAMINED,
  RUNGS,
} from "../lib/criteria.ts";
import type { Profile, Profiles } from "../lib/profiles.ts";
import { GUIDE, GUIDE_ID, METHOD_TERMS, PROFILE_WHO } from "./guide-text.ts";
import { LABEL, SHEET_LABEL } from "./labels.ts";
import { type Marks, scoreChip } from "./marks.ts";
import { moduleTitle } from "./model.ts";

/** The modules by number, M0 first: the guide is a reference, the map holds the adoption order. */
const byNumber = (modules: readonly Module[]) =>
  [...modules].sort(
    (a, b) => Number(a.module.slice(1)) - Number(b.module.slice(1)),
  );

const nameOf = (m: Module) => moduleTitle(m).slice(m.module.length + 1);

const part = (id: string, head: string, body: string) =>
  `<section class="g-sec" id="${id}"><h3>${esc(head)}</h3>${body}</section>`;

const paras = (texts: readonly string[]) =>
  texts.map((t) => `<p>${esc(t)}</p>`).join("");

function idea(): string {
  const G = GUIDE.idea;
  const rungs = ([...RUNGS, EXPECTED_ABSENT, NOT_EXAMINED] as const)
    .map((r) => `<li>${scoreChip(r)}<span>${esc(G.rung[r])}</span></li>`)
    .join("");
  const unscored = `<li>${scoreChip(null)}<span>${esc(G.unscored)}</span></li>`;
  return part(
    GUIDE_ID.idea,
    G.h,
    `<p>${esc(G.p)}</p><h4 id="${GUIDE_ID.ladder}">${esc(G.ladderH)}</h4><p>${esc(G.ladder)}</p><ol class="g-ladder">${rungs}${unscored}</ol><p>${esc(G.higher)}</p>`,
  );
}

function modulesPart(modules: readonly Module[], marks: Marks): string {
  const G = GUIDE.modules;
  const list = byNumber(modules)
    .map(
      (m) =>
        `<li>${marks.chip(m.module)}<span><b>${esc(nameOf(m))}</b>${esc(m.purpose)}</span></li>`,
    )
    .join("");
  return part(
    GUIDE_ID.modules,
    G.h,
    `<p>${esc(G.p)}</p><h4 id="${GUIDE_ID.levels}">${esc(G.levelsH)}</h4><p>${esc(G.levels)}</p><p>${esc(G.list)}</p><ul class="g-mods">${list}</ul>`,
  );
}

/** What a profile asks of a module: its target, a conditional target with its condition, or a dash. */
function targetCell(p: Profile, module: string): string {
  const level = p.targets.get(module);
  if (level)
    return `<td><span class="lv">${esc(LABEL.levelWord[level])}</span></td>`;
  const c = p.conditional.get(module);
  if (c)
    return `<td><span class="lv">${esc(LABEL.levelWord[c.level])}</span><span class="g-when">${esc(GUIDE.profiles.when)} ${esc(c.when)}</span></td>`;
  return `<td><span class="nos">${esc(GUIDE.profiles.none)}</span></td>`;
}

/** Every module against every profile: the target each sets, read from the profiles. */
export function profileTable(
  modules: readonly Module[],
  profiles: Profiles,
  marks: Marks,
): string {
  const list = [...profiles.profiles.values()];
  const head = list.map((p) => `<th scope="col">${esc(p.name)}</th>`).join("");
  const rows = byNumber(modules)
    .map(
      (m) =>
        `<tr><th scope="row">${marks.chip(m.module)} ${esc(nameOf(m))}</th>${list.map((p) => targetCell(p, m.module)).join("")}</tr>`,
    )
    .join("");
  return `<div class="g-tw"><table class="chgt g-pt"><thead><tr><th scope="col">${esc(LABEL.module)}</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function profilesPart(
  modules: readonly Module[],
  profiles: Profiles,
  marks: Marks,
): string {
  const G = GUIDE.profiles;
  const who = [...profiles.profiles.values()]
    .map(
      (p) => `<dt>${esc(p.name)}</dt><dd>${esc(PROFILE_WHO[p.id] ?? "")}</dd>`,
    )
    .join("");
  return part(
    GUIDE_ID.profiles,
    G.h,
    `<p>${esc(G.p)}</p><dl class="g-who">${who}</dl><p class="g-note">${esc(G.names)}</p>${paras([G.dial, G.heading, G.conditional, G.table])}${profileTable(modules, profiles, marks)}`,
  );
}

const defs = (items: readonly (readonly [string, string])[], cls: string) =>
  `<dl class="${cls}">${items.map(([dt, dd]) => `<dt>${esc(dt)}</dt><dd>${esc(dd)}</dd>`).join("")}</dl>`;

function processPart(): string {
  const steps = GUIDE.process.steps
    .map(([name, text]) => `<li><b>${esc(name)}.</b> ${esc(text)}</li>`)
    .join("");
  return part(
    GUIDE_ID.process,
    GUIDE.process.h,
    `<ol class="g-steps">${steps}</ol>`,
  );
}

function wordsPart(hasTerms: boolean): string {
  const words = Object.values(METHOD_TERMS).map(
    (t) => [t.term, t.meaning] as const,
  );
  const own = hasTerms
    ? `<p>${esc(GUIDE.words.own)} <a href="#terms">${esc(LABEL.terms)}</a>.</p>`
    : "";
  return part(
    GUIDE_ID.words,
    GUIDE.words.h,
    defs(words, "terms g-words") + own,
  );
}

function morePart(): string {
  const links = GUIDE.more.links
    .map(([text, url]) => `<li>${extLink(url, text)}</li>`)
    .join("");
  return `<section class="g-sec"><h3>${esc(GUIDE.more.h)}</h3><ul class="g-links">${links}</ul></section>`;
}

const TOC: readonly [string, string][] = [
  [GUIDE_ID.what, GUIDE.what.h],
  [GUIDE_ID.idea, GUIDE.idea.h],
  [GUIDE_ID.modules, GUIDE.modules.h],
  [GUIDE_ID.profiles, GUIDE.profiles.h],
  [GUIDE_ID.process, GUIDE.process.h],
  [GUIDE_ID.read, GUIDE.read.h],
  [GUIDE_ID.words, GUIDE.words.h],
];

export interface GuideInput {
  modules: readonly Module[];
  profiles: Profiles;
  /** Whether the report has its own terms, which the guide then points to. */
  hasTerms: boolean;
  marks: Marks;
}

/** The guide, as the page's last section. */
export function guideSection(g: GuideInput): string {
  const toc = TOC.map(
    ([id, text]) => `<li><a href="#${id}">${esc(text)}</a></li>`,
  ).join("");
  const body = [
    `<p class="g-back" data-js hidden><a href="#top" data-back>← ${esc(SHEET_LABEL.backToReport)}</a></p>`,
    `<p class="intro">${esc(GUIDE.intro)}</p>`,
    `<nav class="g-toc" aria-label="${esc(GUIDE.head)}"><ol>${toc}</ol></nav>`,
    part(GUIDE_ID.what, GUIDE.what.h, paras(GUIDE.what.p)),
    idea(),
    modulesPart(g.modules, g.marks),
    profilesPart(g.modules, g.profiles, g.marks),
    processPart(),
    part(GUIDE_ID.read, GUIDE.read.h, defs(GUIDE.read.items, "g-read")),
    wordsPart(g.hasTerms),
    morePart(),
  ].join("");
  return section(GUIDE.head, body, { id: GUIDE_ID.guide, cls: "guide" });
}

import { definedFields } from "../../../../shared/defined-fields.ts";
/**
 * The HTML projection of an explainer source, on the sheet kit.
 *
 * The order builds the reader's model before the detail: the title block,
 * the summary with the scope beside it, the figures, the flow as numbered
 * steps, then one section per group of claims, the open questions, the terms
 * and the related links. Every step and every claim has its citation in the margin. A
 * `{step:N}` token becomes a link that lights its step on hover and focus.
 *
 * The page is self-contained: no external font, script, stylesheet or image.
 * A figure is inline SVG with its own scoped `<style>` (`figures.ts`), so its
 * text is searchable. Its words come from the cited diagram source, not from
 * the explainer source; the caption names that source.
 */
import {
  claimList,
  esc,
  extLink,
  navItem,
  page,
  section,
  termList,
  topBar,
} from "../../../decide/scripts/sheet-kit/html.ts";
import { createInline } from "../../../decide/scripts/sheet-kit/inline.ts";
import { EXPLAINER_CSS } from "./css.ts";
import { LABEL, SHEET_LABEL } from "./labels.ts";
import { EXPLAINER_SCRIPT } from "./script.ts";
import { type ExplainerSource, splitSteps, stepWords } from "./source.ts";

export const SOURCE_BLOCK_ID = "explainer-source";

/**
 * Render the sheet. `figures` maps each figure id of the source to its built,
 * checked SVG (`figures.ts`); a figure without one is an error, never a gap.
 */
export function renderExplainerHtml(
  source: ExplainerSource,
  figures: ReadonlyMap<string, string> = new Map(),
): string {
  const inline = createInline({
    glossary: source.terms ?? [],
    ...definedFields({ issueUrl: source.url }),
  });
  const steps = new Set((source.flow ?? []).map((s) => s.id));

  /** Source text to HTML in a region: step tokens become links, then the kit links issue ids and terms. */
  const rich = (text: string, seen: Set<string>) =>
    splitSteps(text)
      .map((p) =>
        p.kind === "text"
          ? inline.textHtml(p.text, seen)
          : steps.has(p.step)
            ? `<a class="ref" href="#step-${esc(p.step)}" data-t="s-${esc(p.step)}">${esc(stepWords(p.step))}</a>`
            : esc(stepWords(p.step)),
      )
      .join("");
  const region = () => new Set<string>();

  const nav: string[] = [];
  const parts: string[] = ['<main class="sheet" id="top">'];

  // ---------- the title block ----------
  parts.push(
    `<header class="sec mast"><p class="lab mast-id">${esc(source.id)}<span>${esc(LABEL.sheet)}</span></p><div class="body"><h1>${esc(source.title)}</h1><dl class="meta"><div><dt>${esc(LABEL.factsVerified)}</dt><dd class="mono">${esc(source.verifiedAt.date)} @ ${esc(source.verifiedAt.commit)}</dd></div></dl></div></header>`,
  );

  // ---------- in short, with the scope beside it ----------
  const r0 = region();
  const scopeList = (items: readonly string[]) =>
    `<ul>${items.map((x) => `<li>${rich(x, r0)}</li>`).join("")}</ul>`;
  const summary = `<p>${rich(source.summary, r0)}</p>`;
  let scope = `<h3 class="lab">${esc(LABEL.covers)}</h3>${scopeList(source.scope.covers)}`;
  if (source.scope.excludes?.length)
    scope += `<h3 class="lab">${esc(LABEL.excludes)}</h3>${scopeList(source.scope.excludes)}`;
  parts.push(
    section(
      LABEL.inShort,
      `<div class="main lead">${summary}</div><aside class="side scope">${scope}</aside>`,
      { id: "summary", pair: true },
    ),
  );
  nav.push(navItem("summary", LABEL.inShort));

  // ---------- figures ----------
  for (const f of source.figures ?? []) {
    const svg = figures.get(f.id);
    if (svg === undefined)
      throw new Error(`figure ${f.id}: no built figure was given to embed`);
    const r = region();
    parts.push(
      section(
        LABEL.figure,
        `<figure class="fig">${svg}<figcaption><b>${esc(f.title)}.</b> ${rich(f.caption, r)} <span class="vh">${esc(LABEL.diagramSource)} </span><code>${esc(f.diagram)}</code></figcaption></figure>`,
        { id: `figure-${f.id}`, place: `${LABEL.figure}: ${f.title}` },
      ),
    );
  }

  // ---------- the flow ----------
  if (source.flow?.length) {
    const r = region();
    parts.push(
      section(
        LABEL.flow,
        `<ol class="steps">${source.flow
          .map(
            (s) =>
              `<li class="step pair" id="step-${esc(s.id)}" data-t="s-${esc(s.id)}"><div class="main"><h3><a class="sn" href="#step-${esc(s.id)}" data-t="s-${esc(s.id)}"><span class="vh">${esc(LABEL.refStep)} </span>${esc(s.id)}</a><span>${esc(s.title)}</span></h3><p>${rich(s.text, r)}</p></div><p class="src"><span class="vh">${esc(LABEL.source)} </span><code>${esc(s.source)}</code></p></li>`,
          )
          .join("")}</ol>`,
        { id: "flow" },
      ),
    );
    nav.push(navItem("flow", LABEL.flow));
  }

  // ---------- the sections ----------
  // Section titles are long, so the bar names the first one as Details.
  for (const s of source.sections) {
    const r = region();
    const intro = s.intro ? `<p class="main lead">${rich(s.intro, r)}</p>` : "";
    parts.push(
      section(
        s.title,
        intro + claimList(s.claims, (t) => rich(t, r), LABEL.source),
        { id: `sec-${s.id}` },
      ),
    );
  }
  nav.push(navItem(`sec-${source.sections[0]?.id}`, LABEL.details));

  // ---------- open questions and terms ----------
  if (source.openQuestions?.length) {
    const r = region();
    parts.push(
      section(
        LABEL.openQuestions,
        `<ol class="oq">${source.openQuestions.map((q) => `<li>${rich(q, r)}</li>`).join("")}</ol>`,
        { id: "open", cls: "heavy" },
      ),
    );
    nav.push(navItem("open", LABEL.openQuestions));
  }
  if (source.terms?.length) {
    parts.push(
      section(LABEL.terms, termList(source.terms, inline.termIds), {
        id: "terms",
        ...(source.openQuestions?.length ? {} : { cls: "heavy" }),
      }),
    );
    nav.push(navItem("terms", LABEL.terms));
  }
  if (source.related?.length) {
    parts.push(
      section(
        LABEL.related,
        `<ul class="rel">${source.related
          .map((r) => `<li>${extLink(r.url, r.text)}</li>`)
          .join("")}</ul>`,
        { id: "related" },
      ),
    );
    nav.push(navItem("related", LABEL.related));
  }
  parts.push("</main>");

  return page({
    title: `${source.id}: ${source.title}`,
    css: EXPLAINER_CSS,
    body:
      topBar({ id: source.id, navLabel: SHEET_LABEL.navContents, nav }) +
      parts.join(""),
    source: { id: SOURCE_BLOCK_ID, value: source },
    script: EXPLAINER_SCRIPT,
  });
}

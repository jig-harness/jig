/**
 * The sheet kit: the reading system that every sheet genre shares.
 * A sheet is one self-contained HTML file rendered from a typed source. It
 * needs no external font, script, stylesheet or image, it reads without
 * JavaScript and in print, and it embeds its own source so a later run can
 * regenerate it from the file alone.
 *
 * This file holds the HTML pieces: escaping, the embedded source block, the
 * page shell, the top bar, a labelled section, a list of cited claims and a
 * list of terms. `css.ts` and `script.ts` hold the stylesheet and script
 * fragments, `inline.ts` turns source text into linked HTML, `source.ts`
 * validates, `freshness.ts` checks citations against a commit, and
 * `markdown.ts` escapes markdown.
 *
 * There is one copy of the kit, in the `decide` skill. Another skill that
 * renders a sheet (`explain`) imports it by a relative path: the skills ship
 * together in one plugin, so a sibling skill's directory is always beside
 * this one.
 *
 * Extract only what two genres use. A piece one genre needs stays in that
 * genre's template.
 */

/** Escape for text and double-quoted attribute contexts. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** URLs reach an `href` only when they are https; anything else renders as text. */
export function link(url: string, text: string): string {
  return /^https:\/\//.test(url)
    ? `<a href="${esc(url)}">${esc(text)}</a>`
    : esc(text);
}

/** An external link that print expands with its address: https only, anything else is plain text. */
export function extLink(url: string, text: string): string {
  return /^https:\/\//.test(url)
    ? `<a class="ext" href="${esc(url)}">${esc(text)}</a>`
    : esc(text);
}

/** JSON safe inside a `<script type="application/json">` block: no `</script>` or `<!--` can form. */
export function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/**
 * Recover the source embedded by `page` from a rendered sheet. The block may
 * carry one `data-template` attribute; `attribute` reads it.
 */
export function extractEmbedded(
  html: string,
  blockId: string,
  what: string,
): { value: unknown; template: string | undefined } {
  const match = new RegExp(
    `<script type="application/json" id="${blockId}"(?: data-template="([a-z]+)")?>([^<]*)</script>`,
  ).exec(html);
  if (!match) throw new Error(`no embedded ${what} (#${blockId}) in this file`);
  return { value: JSON.parse(match[2] as string), template: match[1] };
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Structural colours of every sheet: a neutral, accessible default defined
 * here so a sheet depends on no design-token package. Ink, muted text and
 * the accent each reach WCAG AA (4.5:1) on the surface and the page
 * background; each genre's contrast test holds every pair it draws.
 */
export const PALETTE = {
  bg: "#f8f8f7",
  surface: "#ffffff",
  ink: "#1f2933",
  muted: "#5b6675",
  hair: "#cfd6de",
  hairLight: "#e4e8ed",
  accent: "oklch(0.46 0.12 255)",
} as const;

export interface SectionOptions {
  h?: "h2" | "h3";
  id?: string;
  cls?: string;
  pair?: boolean;
  raw?: boolean;
  /** Where the section sits, for a script that names places; the label by default. */
  place?: string;
}

/** A labelled section: the label hangs in the left column, the body reads in the middle. */
export function section(
  label: string,
  body: string,
  o: SectionOptions = {},
): string {
  const h = o.h ?? "h2";
  return `<section class="sec${o.cls ? ` ${o.cls}` : ""}"${o.id ? ` id="${esc(o.id)}"` : ""} data-place="${esc(o.place ?? label)}"><${h} class="lab">${esc(label)}</${h}>${o.raw ? body : `<div class="body${o.pair ? " pair" : ""}">${body}</div>`}</section>`;
}

/** Claims with their citation beside each one. `rich` turns claim text into HTML; `sourceLabel` is read by screen readers before the citation. */
export function claimList(
  items: readonly { text: string; source: string }[],
  rich: (text: string) => string,
  sourceLabel: string,
): string {
  return `<ol class="claims">${items
    .map(
      (x) =>
        `<li class="pair"><p class="main">${rich(x.text)}</p><p class="src"><span class="vh">${esc(sourceLabel)} </span><code>${esc(x.source)}</code></p></li>`,
    )
    .join("")}</ol>`;
}

/** The terms list. Each term is the target its in-text links point at. */
export function termList(
  glossary: readonly { term: string; meaning: string }[],
  ids: readonly string[],
): string {
  return `<dl class="terms">${glossary
    .map(
      (g, i) =>
        `<dt id="${esc(ids[i] as string)}">${esc(g.term)}</dt><dd>${esc(g.meaning)}</dd>`,
    )
    .join("")}</dl>`;
}

export interface TopBar {
  /** The sheet id, linked to the top of the page. */
  id: string;
  /** Accessible name of the contents navigation. */
  navLabel: string;
  /** `<li>` items, already rendered. */
  nav: readonly string[];
  /** An extra class on the bar. */
  cls?: string;
  /** Controls after the time-left slot, already rendered. */
  end?: string;
}

/** The sticky top bar: sheet id, contents, the time left (shown by the script) and a reading-progress rule. */
export function topBar(b: TopBar): string {
  return `<header class="bar${b.cls ? ` ${b.cls}` : ""}"><div class="bar-in"><a class="bar-id" href="#top">${esc(b.id)}</a><nav aria-label="${esc(b.navLabel)}"><ol>${b.nav.join("")}</ol></nav><span class="bar-left" hidden></span>${b.end ?? ""}</div><div class="prog" aria-hidden="true"><i></i></div></header>`;
}

/** A contents entry of the top bar. */
export const navItem = (id: string, label: string) =>
  `<li><a href="#${esc(id)}">${esc(label)}</a></li>`;

export const NAV_SEPARATOR = '<li class="sep" aria-hidden="true"></li>';

export interface Page {
  /** The document title, plain text. */
  title: string;
  css: string;
  /** Everything inside `<body>` before the embedded source, already rendered. */
  body: string;
  /** The source block: its element id, an optional template name, and the source itself. */
  source: { id: string; template?: string; value: unknown };
  script: string;
}

/** The self-contained page: inline style, the body, the inert source block and the inline script. */
export function page(p: Page): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title><style>${p.css}</style></head><body>${p.body}<script type="application/json" id="${p.source.id}"${p.source.template ? ` data-template="${p.source.template}"` : ""}>${embedJson(p.source.value)}</script><script>${p.script}</script></body></html>`;
}

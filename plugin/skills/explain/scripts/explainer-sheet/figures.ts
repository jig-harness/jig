/**
 * Archify figures in an explainer sheet. Archify is an open-source tool that
 * draws architecture diagrams from typed JSON sources
 * (https://github.com/tt-a1i/archify).
 *
 * A figure is the static SVG that Archify's renderer draws, taken before
 * Archify wraps it in its viewer page. The repository's figure build
 * (`explain.figure_build_command`) writes it next to the diagram source as
 * `<stem>.figure.svg`: the SVG with
 * one `<style>` inside holding only the rules its classes need, every
 * selector scoped under the figure's own id, and every element id prefixed
 * with `fig-<stem>--` (a stem is kebab-case, so it never holds `--` and two
 * figures cannot share an id). So a figure's classes and ids cannot collide
 * with the sheet's or another figure's, its text stays searchable and
 * selectable, and it needs no network request. The viewer's interactivity
 * stays out; the full Archify page is the place for it.
 *
 * The renderer embeds the file as markup, so it checks it again here and
 * fails closed. The builder wrote this format, so the check pins it rather
 * than denying known-bad shapes: it tokenizes the whole file with a strict grammar, and anything the
 * grammar does not name is a problem.
 *
 * - Markup: one `<svg>` root holding well-nested elements from a fixed list,
 *   each attribute from a fixed list (or `data-*`), written `name="value"`
 *   after whitespace, with no `&`, `<` or `>` in a value. Text holds only the
 *   five XML entities. No comment, doctype, processing instruction, script,
 *   link, event handler or `style` attribute can be written in this grammar.
 * - Provenance: the root's `data-source-sha256` equals the SHA-256 of the
 *   diagram source now. A figure built from an older source is stale.
 * - Style: exactly one bare `<style>`, the root's first child, a flat list
 *   of `selector{declarations}` rules. Every selector starts with
 *   `#fig-<stem>` followed by its end, a space, `>`, `.` or `[`; no `+`, `~`
 *   or parenthesis anywhere, so no rule reaches outside the figure. No
 *   at-rule, escape, comment or `&`; only properties from a fixed list (so
 *   no rule can position the figure over the sheet); no `image-set()` or
 *   `src()`; `url()`, in any case, only to the figure's own ids.
 * - Every class the SVG uses is named by the last compound of a selector that
 *   matches an element carrying it (the whole selector, ancestors included,
 *   not just its tail). A class with no rule renders as solid black, which is
 *   what an Archify pin bump can cause.
 * - No viewer controls: `tabindex` and `aria-pressed` are not allowed, and
 *   `role` is only `img`, since a static figure has no handlers for them.
 * - Every element id is `fig-<stem>` or starts with `fig-<stem>--`, and so
 *   does every `url(#…)` target.
 */
import { createHash } from "node:crypto";

export const figureDomId = (stem: string) => `fig-${stem}`;

/** The prefix of every element id inside a figure. */
export const figureIdPrefix = (stem: string) => `fig-${stem}--`;

/** The built figure file of a diagram source: `<dir>/<stem>.<type>.json` → `<dir>/<stem>.figure.svg`. */
export function figureFile(diagram: string): string {
  return diagram.replace(/\.[a-z]+\.json$/, ".figure.svg");
}

export const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** The elements a static Archify figure is drawn with. A new one is a pinned-format change: add it here deliberately. */
const ELEMENTS = new Set([
  "svg",
  "g",
  "defs",
  "title",
  "desc",
  "style",
  "marker",
  "pattern",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
]);

/** Presentation and structure attributes, `data-*`, and the ARIA names a figure uses. No `style`, no event handler, no link. */
const ATTRIBUTE =
  /^(?:data-[a-z0-9-]+|aria-(?:hidden|label|labelledby|describedby)|id|class|role|lang|viewBox|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|width|height|transform|fill|stroke|stroke-width|stroke-dasharray|stroke-linecap|stroke-linejoin|opacity|font-size|font-weight|text-anchor|dominant-baseline|marker-start|marker-end|markerWidth|markerHeight|refX|refY|orient|patternUnits)$/;

const TOKEN =
  /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9-]*="[^"<>&]*")*)\s*(\/?)>|<\/([a-zA-Z][a-zA-Z0-9]*)\s*>|[^<&]+|&(?:amp|lt|gt|quot|#39);/y;
const ATTR = /\s+([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
const RULE = /([^{}]+)\{([^{}]*)\}/g;
/** CSS function names are case-insensitive: `URL(` loads exactly like `url(`. */
const URL_REF = /url\(([^)]*)\)/gi;

/**
 * The properties a figure's rules may set: custom properties, SVG paint,
 * stroke and text, and the few box properties Archify's reset uses. No
 * `position`, `z-index`, `inset` or offset, so a rule cannot lift the figure
 * over the sheet; no `content`, `background` or `cursor`, which load or add
 * content.
 */
const PROPERTY =
  /^(?:--[a-z0-9-]+|fill|fill-opacity|stroke|stroke-opacity|stroke-width|stroke-dasharray|stroke-dashoffset|stroke-linecap|stroke-linejoin|vector-effect|opacity|color|font-family|font-size|font-weight|font-style|letter-spacing|text-anchor|dominant-baseline|paint-order|transform-box|transform-origin|pointer-events|display|box-sizing|margin|padding|width|height|min-width|max-width)$/;

interface DrawnElement {
  tag: string;
  classes: string[];
  attributes: Map<string, string>;
  parent: DrawnElement | undefined;
}

interface Compound {
  /** The classes the compound names: the only ones a rule with this compound last credits. */
  classes: string[];
  matches(el: DrawnElement): boolean;
}

/** A scoped selector read whole: compounds with the combinator between each pair (`' '` descendant, `'>'` child). */
interface Selector {
  compounds: Compound[];
  combinators: (" " | ">")[];
}

const COMPOUND_PART =
  /^(?:#([A-Za-z_][\w-]*)|\.([A-Za-z_][\w-]*)|\[([^\]=\s]+)(?:="([^"]*)")?\]|([A-Za-z][\w-]*))/;

/**
 * A compound of tag, id, classes and `[attr]` / `[attr="v"]` conditions. One
 * it cannot read (a pseudo-class, another attribute operator) matches nothing,
 * so an unrecognised selector never counts as styling an element.
 */
function parseCompound(text: string): Compound {
  const classes: string[] = [];
  const attributes: [string, string | undefined][] = [];
  let tag: string | undefined;
  let id: string | undefined;
  let rest = text;
  let readable = text !== "";
  while (rest !== "") {
    const m = COMPOUND_PART.exec(rest);
    if (!m) {
      readable = false;
      break;
    }
    if (m[1] !== undefined) id = m[1];
    else if (m[2] !== undefined) classes.push(m[2]);
    else if (m[3] !== undefined) attributes.push([m[3], m[4]]);
    else if (m[5] !== undefined) tag = m[5];
    rest = rest.slice(m[0].length);
  }
  return {
    classes,
    matches: (el) =>
      readable &&
      (tag === undefined || tag === el.tag) &&
      (id === undefined || el.attributes.get("id") === id) &&
      classes.every((c) => el.classes.includes(c)) &&
      attributes.every(([name, value]) => {
        const have = el.attributes.get(name);
        return have !== undefined && (value === undefined || have === value);
      }),
  };
}

/**
 * Split a selector into compounds and combinators, outside any `[...]`. One
 * with a leading, trailing or doubled combinator is not valid CSS and reads as
 * `undefined`, which matches nothing.
 */
function parseSelector(selector: string): Selector | undefined {
  const compounds: Compound[] = [];
  const combinators: (" " | ">")[] = [];
  let current = "";
  let pending: " " | ">" | undefined;
  let depth = 0;
  const flush = () => {
    if (current === "") return;
    if (compounds.length > 0) combinators.push(pending ?? " ");
    compounds.push(parseCompound(current));
    current = "";
    pending = undefined;
  };
  for (const c of selector) {
    if (c === "[") depth++;
    else if (c === "]") depth--;
    if (depth === 0 && (c === " " || c === ">")) {
      flush();
      if (c === ">") {
        if (pending === ">" || compounds.length === 0) return undefined;
        pending = ">";
      } else pending ??= " ";
    } else current += c;
  }
  flush();
  if (compounds.length === 0 || pending === ">") return undefined;
  return { compounds, combinators };
}

/** Whether the whole selector matches the element: the last compound on it, each earlier one on an ancestor the combinator allows. */
function selectorMatches(sel: Selector, el: DrawnElement): boolean {
  const from = (i: number, e: DrawnElement): boolean => {
    if (!(sel.compounds[i] as Compound).matches(e)) return false;
    if (i === 0) return true;
    if (sel.combinators[i - 1] === ">")
      return e.parent !== undefined && from(i - 1, e.parent);
    for (let a = e.parent; a !== undefined; a = a.parent)
      if (from(i - 1, a)) return true;
    return false;
  };
  return from(sel.compounds.length - 1, el);
}

/** Problems with a built figure; empty when it may be embedded. */
export function figureProblems(
  svg: string,
  stem: string,
  sourceSha256: string,
): string[] {
  const id = figureDomId(stem);
  const prefix = figureIdPrefix(stem);
  const problems: string[] = [];
  const text = svg.trim();
  const ownUrl = (target: string) => target.startsWith(`#${prefix}`);

  // ---------- markup: tokenize the whole file ----------
  const stack: string[] = [];
  const ancestors: DrawnElement[] = [];
  const classes = new Set<string>();
  const drawn: DrawnElement[] = [];
  let css: string | undefined;
  let styles = 0;
  let rootDone = false;
  let at = 0;
  TOKEN.lastIndex = 0;
  while (at < text.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) {
      problems.push(
        `markup outside the figure format at offset ${at}: ${JSON.stringify(text.slice(at, at + 40))}`,
      );
      break;
    }
    at = TOKEN.lastIndex;
    const [token, open, attrs = "", selfClose, close] = m;
    if (rootDone) {
      problems.push("holds content after the root </svg>");
      break;
    }
    if (open !== undefined) {
      if (stack.length === 0 && (open !== "svg" || at !== token.length))
        problems.push("is not one <svg> element");
      if (!ELEMENTS.has(open)) problems.push(`holds a <${open}> element`);
      const element: DrawnElement = {
        tag: open,
        classes: [],
        attributes: new Map(),
        parent: ancestors[ancestors.length - 1],
      };
      drawn.push(element);
      for (const [, name, value] of attrs.matchAll(ATTR)) {
        element.attributes.set(name as string, value as string);
        if (!ATTRIBUTE.test(name as string))
          problems.push(`<${open}> carries a ${name} attribute`);
        if (name === "role" && value !== "img")
          problems.push(
            `<${open}> carries role="${value}"; only img is allowed`,
          );
        // CSS decodes a backslash escape in a presentation value (`u\72l(` is
        // `url(`), so the URL check below would never see the reference.
        if ((value as string).includes("\\"))
          problems.push(`<${open}> ${name} holds a backslash`);
        for (const u of (value as string).matchAll(URL_REF))
          if (!ownUrl((u[1] as string).trim()))
            problems.push(`url(${u[1]}) points outside the figure`);
        if (
          name === "id" &&
          value !== id &&
          !(value as string).startsWith(prefix)
        )
          problems.push(`element id "${value}" is not prefixed with ${prefix}`);
        if (name === "class")
          for (const c of (value as string).split(/\s+/))
            if (c) {
              classes.add(c);
              element.classes.push(c);
            }
      }
      if (stack.length === 0) {
        if (!new RegExp(`\\sid="${id}"`).test(attrs))
          problems.push(`root <svg> must carry id="${id}"`);
        const sha = /\sdata-source-sha256="([0-9a-f]{64})"/.exec(attrs)?.[1];
        if (sha === undefined)
          problems.push("root <svg> carries no data-source-sha256");
        else if (sha !== sourceSha256)
          problems.push(
            "was built from another version of its diagram source; rebuild it",
          );
      }
      if (open === "style") {
        styles++;
        if (attrs !== "" || selfClose)
          problems.push("its <style> carries attributes");
        if (stack.length !== 1 || styles !== 1)
          problems.push("its <style> must be the one first child of the root");
        const end = text.indexOf("</style>", at);
        if (end === -1) {
          problems.push("its <style> is not closed");
          break;
        }
        css = text.slice(at, end);
        at = end + "</style>".length;
        continue;
      }
      if (!selfClose) {
        stack.push(open);
        ancestors.push(element);
      }
      continue;
    }
    if (close !== undefined) {
      ancestors.pop();
      if (stack.pop() !== close) {
        problems.push(`</${close}> does not close the open element`);
        break;
      }
      if (stack.length === 0) rootDone = true;
      continue;
    }
    if (stack.length === 0) {
      problems.push("is not one <svg> element");
      break;
    }
  }
  if (!rootDone && problems.length === 0)
    problems.push("is not one <svg> element");
  if (styles !== 1)
    problems.push(`must hold exactly one <style>, holds ${styles}`);

  // ---------- style: a flat list of scoped rules ----------
  const parsedRules: Selector[] = [];
  const source = css ?? "";
  if (/[@\\&<]|\/\*/.test(source))
    problems.push(
      "its <style> holds an at-rule, an escape, an entity or a comment",
    );
  const rules = [...source.matchAll(RULE)];
  if (rules.map((r) => r[0]).join("") !== source)
    problems.push("its <style> is not a flat list of rules");
  const scoped = new RegExp(`^#${id}(?=$|[\\s>.\\[])`);
  for (const [, selectors, declarations] of rules) {
    for (const sel of (selectors as string).split(",")) {
      const s = sel.trim();
      if (!scoped.test(s) || /[+~()]/.test(s))
        problems.push(`selector "${s}" is not scoped under #${id}`);
      const parsed = parseSelector(s);
      if (parsed) parsedRules.push(parsed);
    }
    const d = declarations as string;
    if (/image-set\(|\bsrc\(|expression\(/i.test(d))
      problems.push("a declaration loads content outside url()");
    for (const decl of d.split(";")) {
      if (decl.trim() === "") continue;
      const name = /^\s*([^:\s]+)\s*:/.exec(decl)?.[1];
      if (name === undefined || !PROPERTY.test(name))
        problems.push(`a rule sets ${name ?? "a malformed declaration"}`);
    }
    for (const m of d.matchAll(URL_REF))
      if (!ownUrl((m[1] as string).trim()))
        problems.push(`url(${m[1]}) points outside the figure`);
  }

  // A class is styled when a rule's whole selector matches an element that
  // carries it, and the rule's last compound (the part naming the styled
  // element) names that class. A rule that matches an element by tag or by
  // another class credits none of the element's other classes, and a selector
  // whose ancestors are absent matches nothing.
  const covered = new Set<string>();
  for (const el of drawn)
    for (const rule of parsedRules)
      if (selectorMatches(rule, el))
        for (const c of (rule.compounds[rule.compounds.length - 1] as Compound)
          .classes)
          covered.add(c);
  const bare = [...classes].filter((c) => !covered.has(c)).sort();
  if (bare.length > 0)
    problems.push(`class(es) with no CSS rule: ${bare.join(", ")}`);
  return [...new Set(problems)];
}

// Writes a Markdown twin next to each built page: `modules/M2/index.html`
// gets `modules/M2/index.md`. The Worker serves the twin to a reader that
// asks for `text/markdown` (worker/index.ts), and `llms.txt` links to it.
//
// A twin is the page's `<main>` converted from the built HTML, so every page
// has one, whether it renders a single document or combines several. It says
// what the page says: what is only there for a reader at a screen (buttons,
// tabs, the breadcrumb, icons) is left out, but what the page tells its
// reader through styling, a label or an attribute is said in text, and code
// is kept character for character. A heading made from a styled label
// becomes a heading, and every link to a page of the site, under any of its
// addresses, points at that page's twin, so an agent that follows links stays
// in Markdown. A link keeps its `#anchor`, and the
// twin it lands on carries that anchor as `<a id="...">` where the element
// with the id begins, so the anchor names the same part in the twin as on
// the page. Only ids some twin links to are kept, so a twin is not strewn
// with anchors nothing uses.
//
// Twins are written for pages at a directory address (`.../index.html`);
// the not-found page is not one, and has no twin.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Element, ElementContent, Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { CONTINUE, SKIP, visit } from "unist-util-visit";
import { cli } from "../../lib/cli.ts";
import {
  encodedRoute,
  percentDecoded,
  routeAddress,
  routePath,
  SITE_ORIGIN,
} from "../src/lib/origin.ts";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

/** The twin's route for a page route: `/modules/M2/` -> `/modules/M2/index.md`. */
export const twinRoute = (route: string): string => `${route}index.md`;

const classesOf = (el: Element): string[] =>
  String(el.properties?.className ?? "")
    .split(/[ ,]+/)
    .filter(Boolean);

function textOf(node: Root | Element): string {
  return node.children
    .map((c) =>
      c.type === "text" ? c.value : c.type === "element" ? textOf(c) : "",
    )
    .join("");
}

/** Elements that exist for a reader at a screen, not for the content. */
function isChrome(el: Element, parent: Element | Root): boolean {
  const classes = classesOf(el);
  return (
    ([
      "script",
      "style",
      "svg",
      "button",
      "kbd",
      "noscript",
      "form",
      "nav",
    ].includes(el.tagName) &&
      !isChoice(el)) ||
    // A code block's language label: the fence says it (see codeLanguage).
    (el.tagName === "figcaption" &&
      parent.type === "element" &&
      classesOf(parent).includes("code")) ||
    (el.properties?.hidden !== undefined && !isChoicePanel(el)) ||
    el.properties?.ariaHidden === "true" ||
    classes.some((c) => ["tabs", "checks-head"].includes(c))
  );
}

const INLINE = new Set(["a", "span", "strong", "em", "code", "small"]);

/**
 * A choice a reader makes on the page, such as an adoption profile: a radio
 * button whose content is the choice, and the panel shown for it (hidden
 * until chosen). A twin shows every choice and every panel.
 */
const isChoice = (el: Element): boolean =>
  el.tagName === "button" && el.properties?.role === "radio";
const isChoicePanel = (el: Element): boolean =>
  el.properties?.dataForProfile !== undefined;

/** The panels shown for a choice inside an element. */
function choicePanelsIn(el: Element): Element[] {
  const panels: Element[] = [];
  visit(el, "element", (child) => {
    if (child !== el && isChoicePanel(child)) {
      panels.push(child);
      return SKIP;
    }
  });
  return panels;
}

/**
 * Code, which the converter keeps as its text: no separating spaces are put
 * between its tokens.
 */
const CODE = new Set([
  "code",
  "kbd",
  "listing",
  "plaintext",
  "pre",
  "samp",
  "tt",
  "var",
  "xmp",
]);

/**
 * Whether converting `el` keeps an anchor placed among its children. Some
 * conversions keep none of an element's children (code is kept as its text,
 * an image is made from its attributes, and many elements are left out), and
 * which ones is the converter's to say, so it is asked: `el` is converted in
 * its place, inside its `ancestors` (outermost first), with its attributes
 * and an anchor in place of its children. Its place matters: a table inside
 * a table, for one, is kept only as its text.
 */
function keepsAnAnchorInside(
  el: Element,
  ancestors: readonly Element[],
): boolean {
  const probe: Root = {
    type: "root",
    children: [
      ancestors.reduceRight<Element>(
        (inner, ancestor) => ({ ...ancestor, children: [inner] }),
        { ...el, children: [anchorElement(ANCHOR)] },
      ),
    ],
  };
  let kept = false;
  visit(
    unified().use(rehypeRemark, { handlers: anchorHandlers }).runSync(probe),
    "html",
    (node) => {
      if (node.value === anchorHtml(ANCHOR)) kept = true;
    },
  );
  return kept;
}

/** The tag of the element that stands for a kept anchor until conversion. */
const ANCHOR = "jig-anchor";

/** The page's `<main>`, or nothing when it has none. */
function mainOf(tree: Root): Root["children"] {
  let main: Element | undefined;
  visit(tree, "element", (el) => {
    if (el.tagName === "main") {
      main = el;
      return SKIP;
    }
  });
  return main ? [main] : [];
}

/**
 * The content of a built page as hast, made ready to convert. `route` is the
 * page's own, `known` the set of the site's page routes, which have twins,
 * and `anchors` the ids on this page that a twin links to.
 */
function prepare(
  route: string,
  known: ReadonlySet<string>,
  anchors: ReadonlySet<string>,
) {
  const aliases = pageAliases(known);
  return () => (tree: Root) => {
    tree.children = mainOf(tree);
    const choices = new Map<string, string>();
    visit(tree, "element", (el) => {
      if (isChoice(el))
        choices.set(
          String(el.properties.dataProfile),
          textOf(el.children.find(isClass("answer")) ?? el).trim(),
        );
    });

    // Every linked id in an element's part is kept: one its rewriting drops,
    // or one on an element left out, is kept where that part begins.
    const parents = new WeakMap<Element, Element>();
    const ancestorsOf = (el: Element): Element[] => {
      const chain: Element[] = [];
      for (let a = parents.get(el); a; a = parents.get(a)) chain.unshift(a);
      return chain;
    };
    visit(tree, "element", (el, index, parent) => {
      if (el.tagName === ANCHOR) return SKIP;
      if (parent?.type === "element") parents.set(el, parent);
      if (classesOf(el).includes("code")) codeLanguage(el);
      const linked = linkedIdsIn(el, anchors, true);
      if (parent && index !== undefined && isDropped(el, parent)) {
        parent.children.splice(index, 1, ...linked.map(anchorElement));
        return [SKIP, index + linked.length];
      }
      const start = sayInText(el, choices);
      absolutize(el, route, known, aliases);
      // An element whose conversion keeps no anchor inside it has its
      // anchors before it; what is inside it is still made ready, since its
      // conversion may keep that as text. Code is kept as written: no
      // separating spaces between its tokens.
      if (linked.length > 0 && !keepsAnAnchorInside(el, ancestorsOf(el))) {
        if (!parent || index === undefined) return SKIP;
        parent.children.splice(index, 0, ...linked.map(anchorElement));
        const next = index + linked.length + 1;
        if (CODE.has(el.tagName)) return [SKIP, next];
        separateInline(el);
        return [CONTINUE, next];
      }
      if (CODE.has(el.tagName)) return SKIP;
      const kept = new Set(linkedIdsIn(el, anchors, false));
      start.children.unshift(
        ...linked.filter((id) => !kept.has(id)).map(anchorElement),
      );
      separateInline(el);
    });
  };
}

/**
 * An element whose meaning the page gives by styling, a label or an
 * attribute, rewritten to say it in text. Returns where its part begins.
 */
function sayInText(el: Element, choices: ReadonlyMap<string, string>): Element {
  // A legend keys marks, which the twin says in words where they are used;
  // only the text it shows for each choice is kept.
  if (classesOf(el).includes("legend")) {
    el.tagName = "div";
    el.children = choicePanelsIn(el);
  }
  if (isChoice(el)) el.tagName = "div";
  if (isChoicePanel(el)) labelPanel(el, choices);
  if (isMapCell(el)) mapCellText(el, choices);
  else if (isLabelledMark(el))
    el.children = [{ type: "text", value: `(${el.properties.ariaLabel})` }];
  else if (isLabelledLink(el))
    el.children = [{ type: "text", value: String(el.properties.ariaLabel) }];
  return classesOf(el).includes("section-head") ? toHeading(el) : el;
}

/**
 * A panel shown for one choice, headed by the choice's name. A panel set in a
 * line of text (a span) becomes a paragraph of its own that opens with the
 * name, unless its text already names the choice.
 */
function labelPanel(el: Element, choices: ReadonlyMap<string, string>): void {
  delete el.properties.hidden;
  const name = choices.get(String(el.properties.dataForProfile));
  if (INLINE.has(el.tagName)) {
    el.tagName = "p";
    if (name && !textOf(el).includes(name))
      el.children.unshift(
        {
          type: "element",
          tagName: "strong",
          properties: {},
          children: [{ type: "text", value: name }],
        },
        { type: "text", value: ": " },
      );
    return;
  }
  if (name)
    el.children.unshift({
      type: "element",
      tagName: "h3",
      properties: {},
      children: [{ type: "text", value: name }],
    });
}

/**
 * A mark whose meaning is only in its label: an empty element with an
 * `aria-label`, such as a criterion's rung.
 */
const isLabelledMark = (el: Element): boolean =>
  typeof el.properties?.ariaLabel === "string" && el.children.length === 0;

/**
 * An inline element whose label says more than the text it shows, because
 * part of what it shows is marks hidden from a screen reader (a station box's
 * glyphs for who runs it, an icon): its label is what it says.
 */
function isLabelledLink(el: Element): boolean {
  if (!INLINE.has(el.tagName) || typeof el.properties?.ariaLabel !== "string")
    return false;
  let marks = false;
  visit(el, "element", (child) => {
    if (child.properties?.ariaHidden === "true" || child.tagName === "svg")
      marks = true;
  });
  return marks;
}

/**
 * A cell of the module map: one level of one module, whose state under each
 * profile (`on`, `cond`, `off`, in profile order) is only in its styling.
 */
const isMapCell = (el: Element): boolean =>
  typeof el.properties?.dataStates === "string";

const CELL_STATE: Record<string, string> = {
  on: "target",
  cond: "target only if its condition holds",
  off: "not targeted",
};

/** A map cell as text: its level, then its state under each profile. */
function mapCellText(el: Element, choices: ReadonlyMap<string, string>): void {
  const label = el.properties.ariaLabel;
  const level =
    typeof label === "string"
      ? (label.split(":")[0] ?? label)
      : textOf({
          ...el,
          children: el.children.filter((c) => !isClass("if")(c)),
        });
  const states = String(el.properties.dataStates)
    .split(/\s+/)
    .filter(Boolean)
    .map(
      (state, i) =>
        `${choices.get(String(i)) ?? `profile ${i + 1}`}: ${CELL_STATE[state] ?? state}`,
    );
  el.children = [
    { type: "text", value: `${level.trim()} (${states.join("; ")})` },
  ];
}

/**
 * A code block (`<figure class="code">`) with its language on its `<code>`,
 * where the conversion reads it: Shiki records it on the `<pre>`
 * (`data-language`), and the block's caption names it either way.
 */
function codeLanguage(figure: Element): void {
  const pre = figure.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "pre",
  );
  const code = pre?.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "code",
  );
  if (!pre || !code) return;
  const caption = figure.children.find(
    (c): c is Element => c.type === "element" && c.tagName === "figcaption",
  );
  const named = pre.properties.dataLanguage;
  const lang =
    typeof named === "string" && named !== "plaintext"
      ? named
      : caption
        ? textOf(caption.children.find(isElement("span")) ?? caption).trim()
        : "";
  const classes = classesOf(code);
  if (
    lang &&
    lang !== "text" &&
    !classes.some((c) => c.startsWith("language-"))
  )
    code.properties.className = [...classes, `language-${lang}`];
}

const isElement =
  (tagName: string) =>
  (c: ElementContent): c is Element =>
    c.type === "element" && c.tagName === tagName;

/**
 * The ids in `anchors` on the elements inside `el`, and on `el` itself when
 * `self` is set.
 */
function linkedIdsIn(
  el: Element,
  anchors: ReadonlySet<string>,
  self: boolean,
): string[] {
  const ids: string[] = [];
  visit(el, "element", (child) => {
    if (child.tagName === ANCHOR) return SKIP;
    const id = child.properties?.id;
    if ((self || child !== el) && typeof id === "string" && anchors.has(id))
      ids.push(id);
  });
  return ids;
}

/** The element that stands for the kept anchor `id` until conversion. */
const anchorElement = (id: string): Element => ({
  type: "element",
  tagName: ANCHOR,
  properties: { id },
  children: [],
});

/** A kept anchor as Markdown: an empty HTML link target. */
function anchorHtml(id: string): string {
  return `<a id="${id.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></a>`;
}

/** The converter's handling of a kept anchor. */
const anchorHandlers = {
  [ANCHOR]: (_state: unknown, node: Element) => ({
    type: "html" as const,
    value: anchorHtml(String(node.properties.id)),
  }),
};

/** Whether an element is left out: chrome, or an image that says nothing. */
const isDropped = (el: Element, parent: Element | Root): boolean =>
  isChrome(el, parent) || (el.tagName === "img" && !el.properties?.alt);

/**
 * A styled section label (`1 · The idea`) as a heading of that text, and the
 * section's note, which can carry an instruction, as a paragraph after it.
 * Returns the heading, where the section begins.
 */
function toHeading(el: Element): Element {
  const label = textOf(el.children.find(isClass("label")) ?? el);
  const note = el.children.find(isClass("note"));
  const heading: Element = {
    type: "element",
    tagName: "h2",
    properties: {},
    children: [{ type: "text", value: label.trim() }],
  };
  el.tagName = "div";
  el.properties = {};
  el.children = [
    heading,
    ...(note
      ? [
          {
            type: "element" as const,
            tagName: "p",
            properties: {},
            children: [{ type: "text" as const, value: textOf(note).trim() }],
          },
        ]
      : []),
  ];
  return heading;
}

/** A link or image address as the twin's reader needs it: a twin, or absolute. */
function absolutize(
  el: Element,
  route: string,
  known: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): void {
  const { href, src } = el.properties ?? {};
  if (el.tagName === "a" && typeof href === "string")
    el.properties.href = twinHref(href, route, known, aliases);
  if (el.tagName === "img" && typeof src === "string")
    el.properties.src = new URL(src, routeAddress(route)).href;
}

const isClass =
  (name: string) =>
  (c: ElementContent): c is Element =>
    c.type === "element" && classesOf(c).includes(name);

/**
 * Two inline elements with nothing between them are two labels set apart by
 * their styling (`Invariant` `the rule, independent of any tool`); in text
 * they need a space, or a line of their own when both are links.
 */
function separateInline(el: Element): void {
  const out: ElementContent[] = [];
  for (const child of el.children) {
    const last = out[out.length - 1];
    if (
      last?.type === "element" &&
      child.type === "element" &&
      INLINE.has(last.tagName) &&
      INLINE.has(child.tagName)
    )
      out.push(
        last.tagName === "a" && child.tagName === "a"
          ? { type: "element", tagName: "br", properties: {}, children: [] }
          : { type: "text", value: " " },
      );
    out.push(child);
  }
  el.children = out;
}

/**
 * Every address that serves one of the site's pages, by the page's route:
 * `/modules/M2/` is also `/modules/M2` and `/modules/M2/index.html`.
 */
function pageAliases(known: ReadonlySet<string>): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const route of known) {
    aliases.set(route, route);
    aliases.set(`${route}index.html`, route);
    if (route !== "/") aliases.set(route.slice(0, -1), route);
  }
  return aliases;
}

/**
 * Where a link on the page at `route` lands in a twin: the twin of a page,
 * under whichever of its addresses the link uses, or an absolute address.
 */
export function twinHref(
  href: string,
  route: string,
  known: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string> = pageAliases(known),
): string {
  let url: URL;
  try {
    url = new URL(href, routeAddress(route));
  } catch {
    return href;
  }
  if (url.origin !== SITE_ORIGIN) return href;
  // The decoded path is for finding the page only; an address is written
  // from the parsed one, or from the page's route encoded, never from it.
  const page = aliases.get(routePath(url.pathname));
  const path = page ? encodedRoute(twinRoute(page)) : url.pathname;
  return `${SITE_ORIGIN}${path}${url.search}${url.hash}`;
}

/**
 * The ids each twin is linked to by, by the route of its page: what a link
 * in the `<main>` of any of `pages` (HTML, by route) names after a `#`.
 */
export function linkedAnchors(
  pages: ReadonlyMap<string, string>,
  known: ReadonlySet<string>,
): Map<string, Set<string>> {
  const anchors = new Map<string, Set<string>>();
  const aliases = pageAliases(known);
  const parser = unified().use(rehypeParse);
  for (const [route, html] of pages) {
    const tree: Root = { type: "root", children: mainOf(parser.parse(html)) };
    visit(tree, "element", (el) => {
      const href = el.properties?.href;
      if (el.tagName !== "a" || typeof href !== "string") return;
      const url = new URL(twinHref(href, route, known, aliases), SITE_ORIGIN);
      const page = routePath(url.pathname).replace(/index\.md$/, "");
      if (url.origin !== SITE_ORIGIN || !url.hash || !known.has(page)) return;
      const ids = anchors.get(page) ?? new Set<string>();
      ids.add(percentDecoded(url.hash.slice(1)));
      anchors.set(page, ids);
    });
  }
  return anchors;
}

/**
 * The `<main>` of the built page at `route` as Markdown, keeping an anchor
 * for each of `anchors`, the ids on it a twin links to.
 */
export async function htmlToMarkdown(
  html: string,
  route: string,
  known: ReadonlySet<string>,
  anchors: ReadonlySet<string> = new Set(),
): Promise<string> {
  const file = await unified()
    .use(rehypeParse)
    .use(prepare(route, known, anchors))
    .use(rehypeRemark, { handlers: anchorHandlers })
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkStringify, { bullet: "-", emphasis: "_", rule: "-" })
    .process(html);
  return String(file).trim().concat("\n");
}

/** The built pages: `index.html` files, by route. */
function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? pageFiles(join(dir, e.name))
      : e.name === "index.html"
        ? [join(dir, e.name)]
        : [],
  );
}

const routeOf = (file: string): string =>
  `/${relative(dist, file).split(sep).join("/")}`.replace(/index\.html$/, "");

async function writeTwins(): Promise<number> {
  if (!existsSync(dist)) {
    console.error("markdown-twins: no dist/ folder; run the build first");
    return 2;
  }
  const pages = new Map(
    pageFiles(dist).map((file) => [routeOf(file), readFileSync(file, "utf8")]),
  );
  const known = new Set(pages.keys());
  const anchors = linkedAnchors(pages, known);
  for (const [route, html] of pages)
    writeFileSync(
      join(dist, twinRoute(route)),
      await htmlToMarkdown(html, route, known, anchors.get(route)),
    );
  console.log(`markdown-twins: ${pages.size} pages`);
  return 0;
}

if (import.meta.main) cli(writeTwins);

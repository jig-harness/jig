// Change notes: one small file per pull request in place of an edit to the
// changelog every pull request would otherwise touch. This file holds the pure
// part: reading a note, choosing the next version, and writing notes into a
// Keep a Changelog file. release.ts applies it to a repository after a merge;
// check.ts holds a branch to it before one.
import { posix } from "node:path";

/** How far a note moves the version, as semantic versioning names it. */
export type Bump = "patch" | "minor" | "major";
const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

/** Keep a Changelog 1.1.0's change types, in the order a section lists them. */
export const SECTIONS = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

export interface ChangeNote {
  /** The note's file name, for messages. */
  file: string;
  /** The release the note asks for; null for a change that ships in none. */
  release: Bump | null;
  /** Prose before the first section: the release's summary. */
  lead: string;
  /** Each change type with its entries, every entry a top-level list item. */
  sections: Map<string, string[]>;
}

/**
 * An inline link's destination and optional title: a destination in `<…>`,
 * or a bare one without spaces or parentheses; a title in `"…"`, `'…'` or
 * `(…)`. A note's every `](` must match it, so the release step can rewrite
 * each link it holds.
 */
const LINK =
  /\]\((?:<([^<>\n]*)>|([^()\s<][^()\s]*))((?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?)\)/g;

/** A destination the release step leaves as it is: a URL, a root-relative path or an anchor. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:|\/|#)/i;

interface Block {
  title: string;
  text: string;
}

/**
 * The lines of `text` with whether each sits inside a fenced code block, so a
 * heading shown as an example in the changelog is not read as structure. As
 * in CommonMark, a fence closes only on a line holding nothing but a run of
 * its own character at least as long as the one that opened it.
 */
function fenced(text: string): { line: string; inFence: boolean }[] {
  let fence: string | null = null;
  const lines: { line: string; inFence: boolean }[] = [];
  for (const line of text.split("\n")) {
    if (fence === null) {
      // A backtick fence's info string holds no backtick.
      const opener = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (opener) fence = opener;
      lines.push({ line, inFence: opener !== undefined });
      continue;
    }
    const closer = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
    if (closer && closer[0] === fence[0] && closer.length >= fence.length)
      fence = null;
    lines.push({ line, inFence: true });
  }
  return lines;
}

/** An ATX heading's level and title, as Markdown renders it; null for any other line. */
function heading(line: string): { level: number; title: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return m?.[1] ? { level: m[1].length, title: (m[2] ?? "").trim() } : null;
}

/** Text before the first heading of `level`, then each heading with its text. */
function blocks(text: string, level: number): { lead: string; parts: Block[] } {
  const lead: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  for (const { line, inFence } of fenced(text)) {
    const h = inFence ? null : heading(line);
    if (h?.level === level) parts.push({ title: h.title, lines: [] });
    else (parts.at(-1)?.lines ?? lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    parts: parts.map((p) => ({
      title: p.title,
      text: p.lines.join("\n").trim(),
    })),
  };
}

/**
 * The top-level list items of a section, each with its continuation lines,
 * split where a line opens with `- ` or `* `. `stray` is whether the parser
 * reads the section as anything but those items: text before or between
 * them, a line indented too little to continue one, or another kind of list.
 */
function entries(text: string): { items: string[]; stray: boolean } {
  const items: string[][] = [];
  for (const { line, inFence } of fenced(text)) {
    if (!inFence && /^[-*] /.test(line)) items.push([line]);
    else items.at(-1)?.push(line);
  }
  return {
    items: items.map((lines) => lines.join("\n").trimEnd()),
    stray: bulletItems(text) !== items.length,
  };
}

/**
 * How many items the text's top-level bullet lists hold, as the parser reads
 * it; null when anything else sits at the top level, such as a paragraph or
 * a numbered list.
 */
function bulletItems(text: string): number | null {
  const other = () => "X";
  const top = Bun.markdown.render(text, {
    // An item's own contents, nested lists included, collapse into it.
    listItem: () => "I",
    list: (children: string, meta?: unknown) =>
      (meta as { ordered?: boolean } | undefined)?.ordered ? "X" : children,
    paragraph: other,
    heading: other,
    blockquote: other,
    code: other,
    hr: other,
    table: other,
    html: other,
  });
  return /^I*$/.test(top.replace(/\s/g, ""))
    ? top.replace(/\s/g, "").length
    : null;
}

/** The note's front matter: the release it asks for, and the body after it. */
function frontMatter(
  file: string,
  text: string,
  errors: string[],
): { body: string; release: Bump | null } {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!front) {
    if (text.startsWith("---\n"))
      errors.push(`${file}: front matter opened with --- is never closed`);
    return { body: text, release: null };
  }
  const values = (front[1] ?? "")
    .split("\n")
    .map((raw) => raw.replace(/\s+#.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => releaseValue(file, line, errors))
    .filter((value) => value !== undefined);
  if (values.length > 1)
    errors.push(`${file}: front matter sets \`release\` twice`);
  return { body: text.slice(front[0].length), release: values[0] ?? null };
}

/**
 * The bump a front-matter line sets; null for a value that is not one, and
 * undefined for a line that is not `release:` at all. Quotes must pair.
 */
function releaseValue(
  file: string,
  line: string,
  errors: string[],
): Bump | null | undefined {
  const raw = /^release:\s*(.*)$/.exec(line)?.[1];
  if (raw === undefined) {
    errors.push(
      `${file}: front matter takes only \`release\`, found \`${line}\``,
    );
    return undefined;
  }
  const value = /^(["'])(.*)\1$/.exec(raw)?.[2] ?? raw;
  if ((BUMPS as readonly string[]).includes(value)) return value as Bump;
  errors.push(
    `${file}: release is one of ${BUMPS.join(", ")}, not \`${value}\``,
  );
  return null;
}

/** What is wrong with one `### <title>` section, if anything. */
function sectionProblem(
  title: string,
  seen: Map<string, string[]>,
  found: { items: string[]; stray: boolean },
): string | null {
  if (!(SECTIONS as readonly string[]).includes(title))
    return `\`### ${title}\` is not a change type (${SECTIONS.join(", ")})`;
  if (seen.has(title)) return `\`### ${title}\` appears twice`;
  if (found.stray)
    return `\`### ${title}\` has text outside a list item: write each change as a "- " item`;
  if (!found.items.length) return `\`### ${title}\` lists no change`;
  return null;
}

/** The element types a note may hold; Bun's parser names them (`Bun.markdown.render`). */
const ALLOWED = new Set([
  "heading",
  "paragraph",
  "list",
  "listItem",
  "link",
  "codespan",
  "strong",
  "emphasis",
]);

/** Every element type Bun's parser reports, so none is rendered by default unseen. */
const ELEMENTS = [
  "heading",
  "paragraph",
  "blockquote",
  "code",
  "list",
  "listItem",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "html",
  "strong",
  "emphasis",
  "link",
  "image",
  "codespan",
  "strikethrough",
] as const;

/** Parts of a table, which `table` refuses as a whole. */
const TABLE_PARTS = new Set(["thead", "tbody", "tr", "th", "td"]);

/** Why a note may not hold an element type that is not in `ALLOWED`. */
const REFUSED: Record<string, string> = {
  code: "a note holds no code block, fenced or indented; show code in a `code span`",
  html: "a note holds no raw HTML, a comment included, which could hide or restyle the changelog after it; put a literal < in a code span or write \\<",
  hr: 'a line of only - or * is a rule, and under a line of text a heading; write each change as a "- " item',
  blockquote: "a note holds no quote; write each change as a plain list item",
  image: "a note holds no image; link to it instead",
  strikethrough: "a note holds no strikethrough",
  table: "a note holds no table; write each change as a list item",
};

/** A sentinel no Markdown text carries, marking a text chunk that is raw inline HTML. */
const RAW = "\u0001";

/**
 * What a note's Markdown holds that the release step could not place, found
 * by parsing it the way a renderer will, with Bun's Markdown parser, rather
 * than modelling Markdown's block and inline rules by hand. A note holds
 * only `###` headings, list items, paragraphs, inline links, code spans and
 * emphasis: every other construct is refused, since each could change how
 * the changelog renders around the note.
 */
function markdownProblems(markdown: string): string[] {
  if (markdown.includes(RAW) || markdown.includes(OPENS))
    return ["a note holds no control characters (U+0001, U+0002)"];
  const problems = new Set<string>();
  const refuse = (kind: string, snippet?: string) =>
    problems.add(
      `${REFUSED[kind] ?? `a note holds no ${kind}`}${snippet?.trim() ? ` (\`${snippet.trim().slice(0, 40)}\`)` : ""}`,
    );
  const callbacks: Record<
    string,
    (children: string, meta?: unknown) => string
  > = {};
  for (const kind of ELEMENTS)
    callbacks[kind] = (children = "", meta) => {
      if (!ALLOWED.has(kind)) {
        if (!TABLE_PARTS.has(kind)) refuse(kind, children.replaceAll(RAW, ""));
        return children.replaceAll(RAW, "");
      }
      const level = (meta as { level?: number } | undefined)?.level;
      if (kind === "heading" && level !== 3)
        problems.add(
          "a note starts at ### (Added, Changed, …); the release step writes the version heading, and a line of only = or - underneath text makes it a heading",
        );
      if ((meta as { checked?: boolean } | undefined)?.checked !== undefined)
        problems.add("a note holds no task list");
      // Raw HTML inside a code span is shown, not rendered.
      return kind === "codespan" ? children.replaceAll(RAW, "") : children;
    };
  // Raw inline HTML reaches the parser's text callback as a chunk of its own
  // that opens with its `<`; an escaped or entity `<` is a chunk of one
  // character. A chunk opening with `<` before a letter, `/`, `!` or `?` is
  // refused, which also refuses a literal one that is not a tag (`<b and`).
  // Bun reads a declaration (`<!x`) as HTML only with an uppercase letter,
  // where the CommonMark spec and the renderers that follow it also take a
  // lowercase one, so `<!` before a letter is refused anywhere in a chunk.
  callbacks.text = (text) =>
    /^<[a-z/!?]/i.test(text) || /<![a-z]/i.test(text) ? RAW + text : text;
  const output = Bun.markdown.render(markdown, callbacks);
  if (output.includes(RAW)) refuse("html", output.split(RAW)[1]);
  // Where a line can open a block, a declaration opens an HTML block, and a
  // footnote definition (`[^1]: text`) a block a renderer with footnotes
  // moves away, even inside what Bun reads as a code span wrapped over the
  // line. Bun opens a declaration's block at any indentation and reads no
  // footnotes, so each is judged by what an ATX heading would do in its place.
  if (opensBlock(markdown, /<![a-z]/gi)) refuse("html", "<!");
  if (opensBlock(markdown, /\[\^[^\]]+\]:/g))
    problems.add(
      "a note holds no footnote: a line opening with [^label]: is moved away from the note; write the text in the item",
    );
  // Every label's shortcut reference goes after the note in one parse, each
  // in a paragraph of its own; any that the note defines raises the count.
  const labels = definitionLabels(markdown);
  if (
    labels.length &&
    countLinks(`${markdown}${labels.map((l) => `\n\n[${l}]\n`).join("")}`) >
      countLinks(markdown)
  )
    problems.add(
      "write the link inline; a reference label is shared by every note in the changelog, so two notes could define it differently. Put a literal ]: in a code span",
    );
  return [...problems];
}

/** Text no note holds, so a heading the probe opens is told from one the note wrote. */
const OPENS = "\u0002";

/**
 * Whether any match of `token` sits where a line opens a block: every match is
 * replaced by an ATX heading marker, which opens a block exactly where a
 * declaration or footnote definition would (at most three columns past its
 * container's text, after its list markers, interrupting a paragraph), and
 * the parser says whether one became a heading. So the container structure is
 * the parser's, never modelled here. One parse answers for every match: a
 * marker that opens no block is inline text, which leaves the block structure
 * around the other markers as it was.
 */
function opensBlock(markdown: string, token: RegExp): boolean {
  let opened = false;
  Bun.markdown.render(markdown.replace(token, `###### ${OPENS}`), {
    heading: (children = "") => {
      if (children.includes(OPENS)) opened = true;
      return children;
    },
  });
  return opened;
}

/**
 * Every `[label]:` in the text, a reference definition's opening or not. A
 * definition may sit in a list item or quote, or have its label wrapped over
 * several lines, so this looks everywhere; `isDefined` tells which are real.
 */
function definitionLabels(markdown: string): string[] {
  return [...markdown.matchAll(/\[((?:[^[\]\\]|\\[\s\S])+)\]:/g)].flatMap(
    (m) => (m[1] ? [m[1]] : []),
  );
}

/**
 * How many links the parser finds in the text. A shortcut reference `[label]`
 * placed after a note is a link only when the note defines the label, so a
 * count that rises tells a real definition from a `]:` inside a link's title
 * or destination, or in ordinary prose.
 */
function countLinks(markdown: string): number {
  let links = 0;
  Bun.markdown.render(markdown, {
    link: (children) => {
      links++;
      return children;
    },
  });
  return links;
}

/** Whether a destination is one the release step rewrites: not a URL, a root-relative path or an anchor. */
function moves(to: string): boolean {
  return !ABSOLUTE.test(to);
}

/**
 * `text` as the parser reads it, each inline link's destination passed
 * through `href`: the structure, text, code spans and links a renderer
 * shows.
 */
function reading(text: string, href: (to: string) => string): string {
  const callbacks: Record<
    string,
    (children: string, meta?: unknown) => string
  > = {};
  for (const kind of ALLOWED)
    callbacks[kind] = (children = "", meta) => {
      if (kind !== "link")
        return `<${kind} ${JSON.stringify(meta ?? null)}>${children}</${kind}>`;
      const { href: to = "", title = null } = (meta ?? {}) as {
        href?: string;
        title?: string | null;
      };
      return `<link ${JSON.stringify([href(to), title])}>${children}</link>`;
    };
  return Bun.markdown.render(text, callbacks);
}

/**
 * Whether rewriting `text`'s links with `target` changes exactly the
 * destinations the parser reads as relative links, to `target` of each, and
 * nothing else the parser reads: no link missed, no code span or prose
 * touched. Judged by parsing both sides, so a backtick the release step
 * pairs differently from the parser (one inside an autolink, say) cannot
 * hide a missed link behind a spurious rewrite.
 */
function rewritesExactly(
  text: string,
  target: (to: string) => string,
): boolean {
  return (
    reading(text, (to) => (moves(to) ? target(to) : to)) ===
    reading(rewrite(text, target), (to) => to)
  );
}

/** A target no real destination equals, so `rewritesExactly` sees every rewrite. */
const PROBE = (to: string) => `probe/${to}`;

/** The links in the note's prose, outside code spans, that the release step could not rewrite. */
function linkProblems(file: string, body: string): string[] {
  const prose = body
    .split(/\n[ \t]*\n/)
    .flatMap((text) => codeSpans(text).filter((_, i) => i % 2 === 0));
  return prose
    .filter(
      (text) => text.split("](").length - 1 !== [...text.matchAll(LINK)].length,
    )
    .map(
      (text) =>
        `${file}: \`${text.trim().slice(0, 60)}\` — a link the release step cannot rewrite: write [text](path) with an optional "title", and put a destination holding a space or parenthesis in <…>`,
    );
}

/**
 * The note as the changelog will hold it: its lead, then each section with
 * its entries. What it holds is what has to pass the parser, so a boundary
 * between blocks is judged where the release step puts it.
 */
function written(lead: string, sections: Map<string, string[]>): string {
  return [
    ...(lead ? [lead] : []),
    ...[...sections].map(
      ([title, items]) => `### ${title}\n\n${items.join("\n")}`,
    ),
  ].join("\n\n");
}

/**
 * Read one change note: optional front matter whose only key is
 * `release: patch|minor|major`, an optional lead, then `### <type>` sections
 * of list items. Returns the note, or what is wrong with it.
 */
export function parseNote(
  file: string,
  text: string,
): { note: ChangeNote | null; errors: string[] } {
  const errors: string[] = [];
  const { body, release } = frontMatter(
    file,
    text.replace(/\r\n/g, "\n"),
    errors,
  );
  errors.push(...linkProblems(file, body));
  const { lead, parts } = blocks(body, 3);
  const sections = new Map<string, string[]>();
  for (const { title, text: sectionText } of parts) {
    const found = entries(sectionText);
    const problem = sectionProblem(title, sections, found);
    if (problem) errors.push(`${file}: ${problem}`);
    else sections.set(title, found.items);
  }
  if (!parts.length)
    errors.push(
      `${file}: a note lists its changes under at least one ### section (${SECTIONS.join(", ")})`,
    );
  if (lead && release === null)
    errors.push(
      `${file}: a lead summarises a release, so it needs \`release:\`; without one, list the change under a ### section`,
    );
  // The body as written, and as the release step will put it in the
  // changelog: its sections and entries, split where the step splits them.
  const markdown = new Set([
    ...markdownProblems(body),
    ...markdownProblems(written(lead, sections)),
  ]);
  errors.push(...[...markdown].map((why) => `${file}: ${why}`));
  // Only a note otherwise sound is released, so only its links need placing.
  if (!errors.length)
    for (const text of [lead, ...[...sections.values()].flat()])
      if (!rewritesExactly(text, PROBE))
        errors.push(
          `${file}: \`${text.trim().slice(0, 60)}\` — the release step reads its links differently from a renderer, so it could not rewrite them (a backtick inside a URL pairs with a later one, say): escape the backtick or write [text](<url>), and write an email address as <mailto:…>`,
        );
  return errors.length
    ? { note: null, errors }
    : { note: { file, release, lead, sections }, errors };
}

/** The version after `current` for the largest of `bumps`; null when there are none. */
export function nextVersion(current: string, bumps: Bump[]): string | null {
  if (!bumps.length) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m)
    throw new Error(
      `cannot bump \`${current}\`: the release step moves only a plain major.minor.patch version`,
    );
  const [major, minor, patch] = [m[1], m[2], m[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const largest = Math.max(...bumps.map((b) => BUMPS.indexOf(b)));
  if (largest === 2) return `${major + 1}.0.0`;
  if (largest === 1) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The note with its relative links rewritten from the note's directory to
 * the changelog's, so a link that works in the note works in the changelog.
 * A note's links are inline (parseNote refuses a reference definition), with
 * or without angle brackets around the destination. An absolute URL, a
 * root-relative path or an anchor is left as it is, and so is anything in a
 * code span, which shows a link rather than being one. A code span is found
 * by pairing backtick runs within one paragraph, which is how Markdown pairs
 * them inside a single block, not across the items of a list; each rewrite
 * is then checked against the parser's reading, and refused where they differ.
 */
export function rebaseLinks(
  note: ChangeNote,
  fromDir: string,
  toDir: string,
): ChangeNote {
  const target = (to: string) =>
    posix.relative(toDir, posix.join(fromDir, to)) || ".";
  const rebase = (text: string) => {
    if (!rewritesExactly(text, target))
      throw new Error(
        `${note.file}: \`${text.trim().slice(0, 60)}\` — its links could not be rewritten the way a renderer reads them`,
      );
    return rewrite(text, target);
  };
  return {
    ...note,
    lead: rebase(note.lead),
    sections: new Map(
      [...note.sections].map(([title, items]) => [title, items.map(rebase)]),
    ),
  };
}

/** `text` with each inline link's destination outside code spans passed through `target`, where it `moves`. */
function rewrite(text: string, target: (to: string) => string): string {
  const to = (dest: string) => (moves(dest) ? target(dest) : dest);
  return inProse(text, (prose) =>
    prose.replace(
      LINK,
      (
        _,
        angled: string | undefined,
        bare: string | undefined,
        title: string,
      ) =>
        angled === undefined
          ? `](${to(bare ?? "")}${title})`
          : `](<${to(angled)}>${title})`,
    ),
  );
}

/**
 * `text` with `edit` applied to its prose: each paragraph outside its code
 * spans, which is where the release step rewrites links.
 */
function inProse(text: string, edit: (prose: string) => string): string {
  return text
    .split(/(\n[ \t]*\n)/)
    .map((part, i) =>
      i % 2
        ? part
        : codeSpans(part)
            .map((span, j) => (j % 2 ? span : edit(span)))
            .join(""),
    )
    .join("");
}

/**
 * `text` split into prose and code spans, the code spans at odd indexes. A
 * span opens with a run of backticks and closes at the next run exactly as
 * long; a run nothing closes is literal text. In prose a backslash escapes
 * the character after it, so `\\\`` opens nothing; inside a span it does not.
 */
function codeSpans(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "`") end++;
    const close = new RegExp(`(?<!\`)\`{${end - i}}(?!\`)`, "g");
    close.lastIndex = end;
    const found = close.exec(text);
    if (!found) {
      i = end;
      continue;
    }
    const after = found.index + found[0].length;
    parts.push(text.slice(start, i), text.slice(i, after));
    start = i = after;
  }
  parts.push(text.slice(start));
  return parts;
}

/** Each note's entries merged into `into` by change type, keeping types in order. */
function mergeSections(into: Block[], notes: ChangeNote[]): Block[] {
  const out = into.map((b) => ({ ...b }));
  for (const note of notes)
    for (const [title, items] of note.sections) {
      const existing = out.find((b) => b.title === title);
      if (existing) {
        existing.text = [existing.text, ...items].filter(Boolean).join("\n");
        continue;
      }
      const rank = SECTIONS.indexOf(title as (typeof SECTIONS)[number]);
      const after = out.findIndex(
        (b) =>
          SECTIONS.indexOf(b.title as (typeof SECTIONS)[number]) > rank &&
          (SECTIONS as readonly string[]).includes(b.title),
      );
      const block = { title, text: items.join("\n") };
      if (after === -1) out.push(block);
      else out.splice(after, 0, block);
    }
  return out;
}

function render(heading: string, lead: string, parts: Block[]): string {
  return [
    heading,
    ...(lead ? [lead] : []),
    ...parts.map((p) => `### ${p.title}\n\n${p.text}`),
  ].join("\n\n");
}

const LINK_REF = /^\[([^\]]+)\]: (\S+)\s*$/;

export interface ApplyOptions {
  /** The version the notes release; null when none asks for one. */
  version: string | null;
  /** The version being replaced, for the comparison link. */
  previous: string;
  /** The release date, year-month-day. */
  date: string;
  /** What a version's tag puts before it, such as `v`. */
  tagPrefix: string;
}

/**
 * The changelog with every note written in: a note without a release joins
 * `## [Unreleased]`; notes with one become the new version's section, placed
 * below Unreleased, with their leads as its summary. When the file ends with
 * comparison links, Unreleased's moves on and the new version gets its own.
 */
export function applyNotes(
  changelog: string,
  notes: ChangeNote[],
  options: ApplyOptions,
): string {
  const lines = fenced(changelog);
  const headings = lines.flatMap(({ line, inFence }, i) =>
    !inFence && heading(line)?.level === 2 ? [i] : [],
  );
  const start = headings.find((i) =>
    heading(lines[i]?.line ?? "")?.title.startsWith("[Unreleased]"),
  );
  if (start === undefined)
    throw new Error("the changelog has no `## [Unreleased]` section");
  const next = headings.find((i) => i > start);
  let end = next ?? lines.length;
  // Without a release section below it, the comparison links at the end of
  // the file are not part of Unreleased.
  if (next === undefined)
    while (
      end > start + 1 &&
      /^(\[[^\]]+\]: \S+\s*|)$/.test(lines[end - 1]?.line ?? "")
    )
      end--;
  const text = (from: number, to: number) =>
    lines
      .slice(from, to)
      .map((l) => l.line)
      .join("\n");
  const head = text(0, start);
  const unreleased = blocks(text(start + 1, end), 3);
  let tail = text(end, lines.length);

  const pending = notes.filter((n) => n.release === null);
  const released = notes.filter((n) => n.release !== null);
  const sections = [
    render(
      lines[start]?.line ?? "## [Unreleased]",
      unreleased.lead,
      mergeSections(unreleased.parts, pending),
    ),
  ];
  if (released.length) {
    if (!options.version)
      throw new Error("notes ask for a release but no version was given");
    sections.push(
      render(
        `## [${options.version}] - ${options.date}`,
        released
          .map((n) => n.lead)
          .filter(Boolean)
          .join("\n\n"),
        mergeSections([], released),
      ),
    );
    tail = moveLinks(tail, options);
  }
  const trimmedTail = tail.replace(/^\n+/, "");
  return `${head.trimEnd()}\n\n${sections.join("\n\n")}\n${trimmedTail ? `\n${trimmedTail}` : ""}`.replace(
    /\n*$/,
    "\n",
  );
}

/** Point Unreleased's comparison link past the new version and add the version's own. */
function moveLinks(tail: string, options: ApplyOptions): string {
  const lines = tail.split("\n");
  const i = lines.findIndex((l) => /^\[Unreleased\]: /.test(l));
  if (i === -1) return tail;
  const url = LINK_REF.exec(lines[i] ?? "")?.[2] ?? "";
  const base = /^(.*)\/compare\/[^/]+\.\.\.HEAD$/.exec(url)?.[1];
  if (!base) return tail;
  const tag = (v: string) => `${options.tagPrefix}${v}`;
  const version = options.version ?? "";
  lines.splice(
    i,
    1,
    `[Unreleased]: ${base}/compare/${tag(version)}...HEAD`,
    `[${version}]: ${base}/compare/${tag(options.previous)}...${tag(version)}`,
  );
  return lines.join("\n");
}

/** The changelog's `## [Unreleased]` section, heading and links aside, for comparing two revisions. */
export function unreleasedSection(changelog: string): string | null {
  const parts = blocks(changelog, 2).parts;
  const section = parts.find((p) => p.title.startsWith("[Unreleased]"));
  if (!section) return null;
  return section.text
    .split("\n")
    .filter((l) => !LINK_REF.test(l))
    .join("\n")
    .trim();
}

/** The versions the changelog has a section for, in order, Unreleased aside. */
export function releasedVersions(changelog: string): string[] {
  return blocks(changelog, 2).parts.flatMap((p) => {
    const m = /^\[([^\]]+)\]/.exec(p.title);
    return m?.[1] && m[1] !== "Unreleased" ? [m[1]] : [];
  });
}

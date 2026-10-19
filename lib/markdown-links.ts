// The link destinations a Markdown file declares, read by a CommonMark
// renderer: Bun's own (`Bun.markdown`), so code spans, fences, escapes,
// containers, multi-line destinations and reference definitions are parsed as
// a renderer parses them rather than approximated. A link or image declares
// its destination; a reference link declares its definition's, and a
// definition nothing uses renders nothing, so declares nothing. Raw HTML is
// not read.
//
// The renderer reports no source positions, so where a destination stands is
// asked of it in one more render. Every place where a destination's text ends
// and a destination could end gets a marker naming that place, and each link
// the renderer reads carries the marker of the place it was read from. Text
// that only repeats a destination (in code, prose or an unused definition)
// renders as no link, so its marker is never read. A link the markers take
// away stands at the first place of its text no other link was read from.
// Only such a link can be an email autolink, since a marker leaves no email an
// email. Two renders, then, whatever the file holds.

/** One destination and the 1-based line it starts on. */
export interface MarkdownLink {
  target: string;
  line: number;
}

/** A destination as the renderer reports it: its source text. */
interface Rendered {
  href: string;
  image: boolean;
}

/** A destination, where its source text starts, and whether a marker read it. */
interface Placed extends Rendered {
  at: number;
  marked: boolean;
}

/** Every link destination `content` declares, ordered by line. */
export function markdownLinks(content: string): MarkdownLink[] {
  const lineOf = lineFinder(content);
  const links = place(content, render(content)).map(
    ({ href, image, at, marked }) => ({
      target:
        !image && !marked && emailAutolink(content, href, at)
          ? `mailto:${href}`
          : unescapeDestination(href),
      line: lineOf(at),
    }),
  );
  return links.sort((a, b) => a.line - b.line);
}

function render(content: string): Rendered[] {
  const rendered: Rendered[] = [];
  Bun.markdown.render(content, {
    link: (children, { href }) => {
      rendered.push({ href, image: false });
      return children;
    },
    image: (children, { src }) => {
      rendered.push({ href: src, image: true });
      return children;
    },
  });
  return rendered;
}

/**
 * Where each rendered destination's source text starts. A link a marker read
 * stands where the marker says; the rest take, in order, the places of their
 * text no marker claimed, or its first place when every one is claimed.
 */
function place(content: string, rendered: Rendered[]): Placed[] {
  const starts = new Map<string, number[]>();
  for (const { href } of rendered)
    if (!starts.has(href)) starts.set(href, indexesOf(content, href));
  const read = readMarked(content, starts);
  const claimed = new Set<number>();
  const placed = rendered.map((link): Placed => {
    const at = read.get(key(link))?.shift();
    if (at === undefined) return { ...link, at: -1, marked: false };
    claimed.add(at);
    return { ...link, at, marked: true };
  });
  const free = new Map<string, number[]>();
  for (const [href, list] of starts)
    free.set(
      href,
      list.filter((at) => !claimed.has(at)),
    );
  for (const link of placed)
    if (link.at === -1)
      link.at = free.get(link.href)?.shift() ?? starts.get(link.href)?.[0] ?? 0;
  return placed;
}

const key = ({ href, image }: Rendered) => `${image ? "!" : ""}${href}`;

/**
 * The places each destination was read from, by `key`, in render order: the
 * file rendered again with a marker at every place a destination's text ends
 * and a destination could end, before `)`, `>`, whitespace or the file's end.
 * A marker is two characters of the Private Use Area, so a file that holds
 * one already is not marked.
 */
function readMarked(
  content: string,
  starts: Map<string, number[]>,
): Map<string, number[]> {
  const read = new Map<string, number[]>();
  const ends = [
    ...new Set(
      [...starts].flatMap(([href, list]) => list.map((at) => at + href.length)),
    ),
  ]
    .filter((end) => /^[ \t\n\r\f\v)>]?$/.test(content[end] ?? ""))
    .sort((a, b) => a - b);
  if (ends.length === 0 || ends.length > MARKS ** 2 || PRIVATE.test(content))
    return read;
  let marked = "";
  ends.forEach((end, id) => {
    marked += content.slice(ends[id - 1] ?? 0, end) + marker(id);
  });
  marked += content.slice(ends.at(-1));
  for (const link of render(marked)) {
    const id = markerId(link.href.slice(-2));
    const href = link.href.replace(MARKER, "");
    const end = id === undefined ? undefined : ends[id];
    if (end === undefined || !content.startsWith(href, end - href.length))
      continue;
    const list = read.get(key({ ...link, href })) ?? [];
    list.push(end - href.length);
    read.set(key({ ...link, href }), list);
  }
  return read;
}

const MARK = 0xe000;
const MARKS = 0x1900;
const PRIVATE = /[\ue000-\uf8ff]/;
const MARKER = /[\ue000-\uf8ff]{2}/g;

function marker(id: number): string {
  return String.fromCharCode(
    MARK + Math.floor(id / MARKS),
    MARK + (id % MARKS),
  );
}

function markerId(text: string): number | undefined {
  const [high, low] = [text.charCodeAt(0) - MARK, text.charCodeAt(1) - MARK];
  return high >= 0 && high < MARKS && low >= 0 && low < MARKS
    ? high * MARKS + low
    : undefined;
}

function indexesOf(content: string, text: string): number[] {
  const found: number[] = [];
  for (
    let index = content.indexOf(text);
    index !== -1 && text !== "";
    index = content.indexOf(text, index + 1)
  )
    found.push(index);
  return found;
}

/**
 * The 1-based line of an index in `content`, which ends a line at CRLF, CR or
 * LF, as CommonMark does.
 */
function lineFinder(content: string): (index: number) => number {
  const starts = [0];
  for (const ending of content.matchAll(/\r\n?|\n/g))
    starts.push(ending.index + ending[0].length);
  return (index) => {
    let [low, high] = [0, starts.length - 1];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/**
 * Whether the link to `href`, written at `at`, is an email autolink
 * (`<a@b.c>`). Only a link no marker read is asked: a marker inside
 * `[x](<a@b.c>)` or a definition leaves a link, inside an autolink none.
 */
function emailAutolink(content: string, href: string, at: number): boolean {
  return (
    /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i.test(
      href,
    ) &&
    content[at - 1] === "<" &&
    content[at + href.length] === ">"
  );
}

/**
 * A destination as the renderer's source text holds it, with its backslash
 * escapes removed and its character references decoded, left to right, so an
 * escaped `&` starts no reference.
 */
function unescapeDestination(target: string): string {
  return target.replace(
    /\\([!-/:-@[-`{-~])|&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g,
    (whole, escaped: string | undefined) =>
      escaped ?? characterReference(whole),
  );
}

/** The text one character reference stands for; an unknown one as written. */
function characterReference(reference: string): string {
  const html = Bun.markdown.html(reference).trim();
  return html
    .replace(/^<p>|<\/p>$/g, "")
    .replace(
      /&(lt|gt|quot|amp);/g,
      (_, name: string) =>
        ({ lt: "<", gt: ">", quot: '"', amp: "&" })[name] ?? "",
    );
}

/** A destination's percent-encoding decoded, or the destination as written. */
export function decode(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

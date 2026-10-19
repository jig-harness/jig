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
// and a destination could end gets a marker naming that place, written in
// Private Use Area characters the file does not hold and as wide as the
// number of places needs, and each link the renderer reads carries the marker
// of the place it was read from. A file holding every Private Use Area
// character leaves nothing to write a marker in, and is refused rather than
// read by guess. Text that only repeats a
// destination (in code, prose or an unused definition) renders as no link, so
// its marker is never read. A marker would leave an email autolink no email,
// so each `<address>` the file holds is written as a URI autolink for that
// render: it stays a link exactly where the address was one, and a link whose
// text is its whole destination is an autolink. An address ends before its
// `>`, so every email autolink is marked.
//
// A marker is read only from a render that is the same document: each render
// also writes the file's outline, every element with its text and metadata
// but no destination, markers and the autolink scheme removed. A marker that
// changes the outline (one that ends a fence line, breaks a label or turns an
// emphasis delimiter) is left out, the places whose markers keep the outline
// found by halving, and a link the markers still miss stands at the first
// place of its text no other link was read from. Two renders, then, unless a
// marker changes the document; then about two more per such marker.

/** One destination and the 1-based line it starts on. */
export interface MarkdownLink {
  target: string;
  line: number;
}

/** A destination as the renderer reports it: its source text. */
interface Rendered {
  href: string;
  image: boolean;
  /** Whether the link's text is its whole destination, as an autolink's is. */
  autolink: boolean;
}

/** Where a destination's source text starts, and whether it is an email autolink. */
interface Read {
  at: number;
  email: boolean;
}

/** Every link destination `content` declares, ordered by line. */
export function markdownLinks(content: string): MarkdownLink[] {
  const lineOf = lineFinder(content);
  const digits = markAlphabet(content);
  const strip = stripper(digits);
  const plain = render(content, strip);
  const links = place(content, plain, digits, strip).map(
    ({ href, at, email }) => ({
      target: email ? `mailto:${href}` : unescapeDestination(href),
      line: lineOf(at),
    }),
  );
  return links.sort((a, b) => a.line - b.line);
}

/** A render's links, in order, and its outline with `strip` applied. */
interface Rendering {
  links: Rendered[];
  outline: string;
}

/** Every element the renderer calls back for, so the outline holds them all. */
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
  "text",
] as const;

function render(content: string, strip: (text: string) => string): Rendering {
  const links: Rendered[] = [];
  // The last text written, as read and as outlined: a link whose children are
  // that text alone, read as its destination, is an autolink.
  let text = { read: "", outlined: "" };
  const callbacks: Record<string, unknown> = {};
  for (const element of ELEMENTS)
    callbacks[element] = (
      children: string | undefined,
      meta: Record<string, unknown> | undefined,
    ) => {
      const inner = children ?? "";
      const outlined = outlineOf(element, inner, meta, strip);
      if (element === "text") text = { read: inner, outlined };
      const link = linkOf(element, meta);
      if (link !== undefined)
        links.push({
          ...link,
          autolink:
            !link.image && inner === text.outlined && text.read === link.href,
        });
      return outlined;
    };
  const outline = Bun.markdown.render(
    content,
    callbacks as Parameters<typeof Bun.markdown.render>[1],
  );
  return { links, outline };
}

/** One element as the outline writes it. */
function outlineOf(
  element: string,
  children: string,
  meta: Record<string, unknown> | undefined,
  strip: (text: string) => string,
): string {
  const inner = element === "text" ? JSON.stringify(strip(children)) : children;
  return `<${element} ${describe(meta, strip)}>${inner}</${element}>`;
}

/** The destination a link or image element declares. */
function linkOf(
  element: string,
  meta: Record<string, unknown> | undefined,
): { href: string; image: boolean } | undefined {
  const href =
    element === "link"
      ? meta?.href
      : element === "image"
        ? meta?.src
        : undefined;
  return typeof href === "string"
    ? { href, image: element === "image" }
    : undefined;
}

/** An element's metadata without its destination, `strip` applied, empty values left out. */
function describe(
  meta: Record<string, unknown> | undefined,
  strip: (text: string) => string,
): string {
  const kept: [string, unknown][] = [];
  for (const [name, value] of Object.entries(meta ?? {})) {
    if (name === "href" || name === "src") continue;
    const shown = typeof value === "string" ? strip(value) : value;
    if (shown !== undefined && shown !== "") kept.push([name, shown]);
  }
  return JSON.stringify(kept);
}

/**
 * Where each rendered destination's source text starts. A link a marker read
 * stands where the marker says; the rest take, in order, the places of their
 * text no marker claimed, or its first place when every one is claimed.
 */
function place(
  content: string,
  plain: Rendering,
  digits: string[],
  strip: (text: string) => string,
): (Rendered & Read)[] {
  const rendered = plain.links;
  const starts = new Map<string, number[]>();
  for (const { href } of rendered)
    if (!starts.has(href)) starts.set(href, indexesOf(content, href));
  const read = readMarked(content, starts, { plain, digits, strip });
  const nextRead = queues(read);
  const claimed = new Set<number>();
  const placed = rendered.map((link) => {
    const found = nextRead(key(link));
    if (found === undefined) return { ...link, at: -1, email: false };
    claimed.add(found.at);
    return { ...link, ...found };
  });
  const free = new Map<string, number[]>();
  for (const [href, list] of starts)
    free.set(
      href,
      list.filter((at) => !claimed.has(at)),
    );
  const nextFree = queues(free);
  for (const link of placed)
    if (link.at === -1)
      link.at = nextFree(link.href) ?? starts.get(link.href)?.[0] ?? 0;
  return placed;
}

/** Takes each list's items in order, one per call, without moving the rest. */
function queues<T>(lists: Map<string, T[]>): (name: string) => T | undefined {
  const taken = new Map<string, number>();
  return (name) => {
    const index = taken.get(name) ?? 0;
    taken.set(name, index + 1);
    return lists.get(name)?.[index];
  };
}

const key = ({ href, image }: Pick<Rendered, "href" | "image">) =>
  JSON.stringify([image, href]);

/**
 * What each destination was read as, by `key`, in render order: the file
 * rendered again as `markFile` writes it, with every marker that keeps the
 * outline.
 */
function readMarked(
  content: string,
  starts: Map<string, number[]>,
  unmarked: {
    plain: Rendering;
    digits: string[];
    strip: (text: string) => string;
  },
): Map<string, Read[]> {
  const read = new Map<string, Read[]>();
  const ends = markableEnds(content, starts);
  if (ends.length === 0) return read;
  const markers = markerSet(unmarked.digits, ends.length);
  const addresses = enclosedAddresses(content, starts);
  const kept = keepOutline(
    ends.map((_, id) => id),
    (ids) => {
      const file = markFile(content, ends, ids, addresses, markers.write);
      const rendering = render(file.marked, unmarked.strip);
      return rendering.outline === unmarked.plain.outline
        ? { file, links: rendering.links }
        : undefined;
    },
  );
  return kept === undefined
    ? read
    : readLinks(content, ends, addresses, kept, markers.read);
}

/** What each link of a marked render was read as, by `key`, in render order. */
function readLinks(
  content: string,
  ends: number[],
  addresses: Map<number, number>,
  { file, links }: { file: MarkedFile; links: Rendered[] },
  idOf: (href: string) => number | undefined,
): Map<string, Read[]> {
  const read = new Map<string, Read[]>();
  for (const link of links) {
    const id = idOf(link.href);
    const end = id === undefined ? undefined : ends[id];
    const markEnd = id === undefined ? undefined : file.markEnds[id];
    if (end === undefined || markEnd === undefined) continue;
    const start = markEnd - link.href.length;
    if (!file.marked.startsWith(link.href, start)) continue;
    const at = file.sourceOf(start);
    const found = key({ href: content.slice(at, end), image: link.image });
    const list = read.get(found) ?? [];
    list.push({ at, email: link.autolink && addresses.get(end) === at });
    read.set(found, list);
  }
  return read;
}

/**
 * The result of `attempt` for the most places it accepts: all of `ids` when
 * it accepts them, else the places found by halving, each half tried beside
 * every place already kept. Every place kept was tried in one attempt with
 * all the others, so the result is that attempt's. Undefined when none is.
 */
function keepOutline<T>(
  ids: number[],
  attempt: (ids: number[]) => T | undefined,
): T | undefined {
  let last: T | undefined;
  const grow = (kept: number[], trying: number[]): number[] => {
    if (trying.length === 0) return kept;
    const all = [...kept, ...trying];
    const result = attempt(all);
    if (result !== undefined) {
      last = result;
      return all;
    }
    if (trying.length === 1) return kept;
    const half = Math.ceil(trying.length / 2);
    return grow(grow(kept, trying.slice(0, half)), trying.slice(half));
  };
  grow([], ids);
  return last;
}

/**
 * Every place a destination's text ends and a destination could end: before
 * `)`, `>`, whitespace or the file's end.
 */
function markableEnds(
  content: string,
  starts: Map<string, number[]>,
): number[] {
  return [
    ...new Set(
      [...starts].flatMap(([href, list]) => list.map((at) => at + href.length)),
    ),
  ]
    .filter((end) => /^[ \t\n\r\f\v)>]?$/.test(content[end] ?? ""))
    .sort((a, b) => a - b);
}

/** The start of each address `<` and `>` enclose, by where it ends. */
function enclosedAddresses(
  content: string,
  starts: Map<string, number[]>,
): Map<number, number> {
  const addresses = new Map<number, number>();
  for (const [href, list] of starts)
    if (EMAIL.test(href))
      for (const at of list)
        if (content[at - 1] === "<" && content[at + href.length] === ">")
          addresses.set(at + href.length, at);
  return addresses;
}

/** A marked file, where each marker ends in it, and the source of its indexes. */
interface MarkedFile {
  marked: string;
  markEnds: number[];
  sourceOf: (index: number) => number;
}

/**
 * `content` with marker `id` at `ends[id]` for each of `ids`, and `SCHEME`
 * before every enclosed address one of them ends; where each marker ends in
 * it; and the place in `content` an index of it was written from.
 */
function markFile(
  content: string,
  ends: number[],
  ids: number[],
  addresses: Map<number, number>,
  marker: (id: number) => string,
): MarkedFile {
  const cuts = ids
    .flatMap((id) => {
      const at = ends[id] ?? 0;
      const address = addresses.get(at);
      const mark = { at, id, text: marker(id) };
      return address === undefined
        ? [mark]
        : [{ at: address, id: -1, text: SCHEME }, mark];
    })
    .sort((a, b) => a.at - b.at);
  const inserted: { from: number; to: number; at: number }[] = [];
  const markEnds: number[] = [];
  let marked = "";
  let from = 0;
  for (const cut of cuts) {
    marked += content.slice(from, cut.at);
    inserted.push({
      from: marked.length,
      to: marked.length + cut.text.length,
      at: cut.at,
    });
    marked += cut.text;
    if (cut.id !== -1) markEnds[cut.id] = marked.length;
    from = cut.at;
  }
  marked += content.slice(from);
  const sourceOf = (index: number): number => {
    let [low, high] = [-1, inserted.length - 1];
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((inserted[middle]?.from ?? 0) < index) low = middle;
      else high = middle - 1;
    }
    const piece = inserted[low];
    if (piece === undefined) return index;
    return piece.to > index ? piece.at : piece.at + index - piece.to;
  };
  return { marked, markEnds, sourceOf };
}

/** A URI scheme that turns `<address>` into a URI autolink holding a marker. */
const SCHEME = "jig-mark:";

const EMAIL =
  /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;

/** A file whose links cannot be marked, because it holds every marker character. */
class UnmarkableMarkdownError extends Error {}

/** Enough Private Use Area characters to write a marker in. */
const ALPHABET_SIZE = 256;

/**
 * Markers for `count` places: fixed-width numbers written in `digits`, Private
 * Use Area characters the file does not hold, and the id of the marker a
 * destination ends with, if it ends with one.
 */
function markerSet(
  digits: string[],
  count: number,
): {
  write: (id: number) => string;
  read: (href: string) => number | undefined;
} {
  if (digits.length === 0 || (digits.length === 1 && count > 1))
    throw new UnmarkableMarkdownError(
      "markdown-links: the file holds every Private Use Area character, so no link in it can be marked",
    );
  let width = 1;
  while (digits.length ** width < count) width++;
  const values = new Map(digits.map((digit, value) => [digit, value]));
  const write = (id: number): string => {
    let text = "";
    for (let left = id, place = 0; place < width; place++) {
      text = (digits[left % digits.length] ?? "") + text;
      left = Math.floor(left / digits.length);
    }
    return text;
  };
  const read = (href: string): number | undefined => {
    let id = 0;
    const tail = [...href.slice(-2 * width)].slice(-width);
    if (tail.length !== width) return undefined;
    for (const digit of tail) {
      const value = values.get(digit);
      if (value === undefined) return undefined;
      id = id * digits.length + value;
    }
    return id;
  };
  return { write, read };
}

/**
 * Up to `ALPHABET_SIZE` Private Use Area characters `content` does not hold,
 * from the Basic Multilingual Plane's area and then planes 15 and 16.
 */
function markAlphabet(content: string): string[] {
  const held = new Set(
    content.match(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu),
  );
  const marks: string[] = [];
  for (const [first, last] of [
    [0xe000, 0xf8ff],
    [0xf0000, 0xffffd],
    [0x100000, 0x10fffd],
  ] as const)
    for (let code = first; code <= last; code++) {
      const mark = String.fromCodePoint(code);
      if (!held.has(mark)) marks.push(mark);
      if (marks.length === ALPHABET_SIZE) return marks;
    }
  return marks;
}

/** Text with every marker digit and `SCHEME` removed. */
function stripper(digits: string[]): (text: string) => string {
  const held = new Set(digits);
  return (text) =>
    [...text.replaceAll(SCHEME, "")].filter((char) => !held.has(char)).join("");
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

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
// `>`, so every email autolink is marked. Two renders, then, whatever the file
// holds; a link the markers still miss stands at the first place of its text
// no other link was read from.

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
  const links = place(content, render(content)).map(({ href, at, email }) => ({
    target: email ? `mailto:${href}` : unescapeDestination(href),
    line: lineOf(at),
  }));
  return links.sort((a, b) => a.line - b.line);
}

function render(content: string): Rendered[] {
  const rendered: Rendered[] = [];
  Bun.markdown.render(content, {
    link: (children, { href }) => {
      rendered.push({ href, image: false, autolink: children === href });
      return children;
    },
    image: (children, { src }) => {
      rendered.push({ href: src, image: true, autolink: false });
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
function place(content: string, rendered: Rendered[]): (Rendered & Read)[] {
  const starts = new Map<string, number[]>();
  for (const { href } of rendered)
    if (!starts.has(href)) starts.set(href, indexesOf(content, href));
  const read = readMarked(content, starts);
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
 * rendered again as `markFile` writes it.
 */
function readMarked(
  content: string,
  starts: Map<string, number[]>,
): Map<string, Read[]> {
  const read = new Map<string, Read[]>();
  const ends = markableEnds(content, starts);
  if (ends.length === 0) return read;
  const markers = markerSet(content, ends.length);
  const addresses = enclosedAddresses(content, starts);
  const file = markFile(content, ends, addresses, markers.write);
  for (const link of render(file.marked)) {
    const id = markers.read(link.href);
    const end = id === undefined ? undefined : ends[id];
    if (id === undefined || end === undefined) continue;
    const start = (file.markEnds[id] ?? 0) - link.href.length;
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

/**
 * `content` with marker `id` at `ends[id]` and `SCHEME` before every
 * enclosed address; where each marker ends in it; and the place in `content`
 * an index of it was written from.
 */
function markFile(
  content: string,
  ends: number[],
  addresses: Map<number, number>,
  marker: (id: number) => string,
): {
  marked: string;
  markEnds: number[];
  sourceOf: (index: number) => number;
} {
  const cuts = [
    ...ends.map((at, id) => ({ at, id, text: marker(id) })),
    ...[...addresses.values()].map((at) => ({ at, id: -1, text: SCHEME })),
  ].sort((a, b) => a.at - b.at);
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
export class UnmarkableMarkdownError extends Error {}

/** Enough Private Use Area characters to write a marker in. */
const ALPHABET_SIZE = 256;

/**
 * Markers for `count` places: fixed-width numbers whose digits are Private Use
 * Area characters `content` does not hold, and the id of the marker a
 * destination ends with, if it ends with one.
 */
function markerSet(
  content: string,
  count: number,
): {
  write: (id: number) => string;
  read: (href: string) => number | undefined;
} {
  const digits = markAlphabet(content);
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

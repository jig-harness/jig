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
// and a destination could end gets a marker naming that place, drawn from
// characters the file does not hold, and each link the renderer reads carries
// the marker of the place it was read from. Text that only repeats a
// destination (in code, prose or an unused definition) renders as no link, so
// its marker is never read. A marker would leave an email autolink no email,
// so each `<address>` the file holds is written as a URI autolink for that
// render: it stays a link exactly where the address was one, and a link whose
// text is its whole destination is an autolink. Two renders, then, whatever
// the file holds; a link the markers still miss stands at the first place of
// its text no other link was read from, and is never taken for an autolink.

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
  const claimed = new Set<number>();
  const placed = rendered.map((link) => {
    const found = read.get(key(link))?.shift();
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
  for (const link of placed)
    if (link.at === -1)
      link.at = free.get(link.href)?.shift() ?? starts.get(link.href)?.[0] ?? 0;
  return placed;
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
  const marks = markAlphabet(content);
  if (ends.length === 0 || ends.length > marks.length ** 2) return read;
  const addresses = enclosedAddresses(content, starts);
  const file = markFile(content, ends, addresses, marks);
  const idOf = markerIds(marks);
  for (const link of render(file.marked)) {
    const id = idOf(link.href.slice(-2));
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
  marks: string,
): {
  marked: string;
  markEnds: number[];
  sourceOf: (index: number) => number;
} {
  const cuts = [
    ...ends.map((at, id) => ({ at, id, text: marker(marks, id) })),
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
    let shift = 0;
    for (const piece of inserted) {
      if (piece.from >= index) break;
      if (piece.to > index) return piece.at;
      shift += piece.to - piece.from;
    }
    return index - shift;
  };
  return { marked, markEnds, sourceOf };
}

/** A URI scheme that turns `<address>` into a URI autolink holding a marker. */
const SCHEME = "jig-mark:";

const EMAIL =
  /^[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;

/** The Private Use Area characters `content` does not hold. */
function markAlphabet(content: string): string {
  const held = new Set(content.match(/[-]/g));
  let marks = "";
  for (let code = 0xe000; code <= 0xf8ff; code++) {
    const mark = String.fromCharCode(code);
    if (!held.has(mark)) marks += mark;
  }
  return marks;
}

/** The id of the marker two characters write, if they write one. */
function markerIds(marks: string): (text: string) => number | undefined {
  const ids = new Map([...marks].map((mark, index) => [mark, index]));
  return (text) => {
    const [high, low] = [...text].map((mark) => ids.get(mark));
    return high === undefined || low === undefined || text.length !== 2
      ? undefined
      : high * marks.length + low;
  };
}

function marker(marks: string, id: number): string {
  return `${marks[Math.floor(id / marks.length)]}${marks[id % marks.length]}`;
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

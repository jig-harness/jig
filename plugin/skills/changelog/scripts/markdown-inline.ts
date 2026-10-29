// The inline Markdown a changelog check reads, by CommonMark's grammar
// (https://spec.commonmark.org/0.31.2/): backslash escapes, code spans, raw
// HTML and autolinks, and links (inline, full, collapsed and shortcut
// reference) with their destinations and titles. A check reads a paragraph
// through it rather than matching raw text, so what it sees is what renders:
// a link inside a code span or an HTML comment is no link, a reference link
// links only where its label has a definition, and a destination may hold
// balanced parentheses. Emphasis is not read: it changes no link. Shared by
// the lint's reader (lint-structure.ts) and its format rules.

/** Whether a link label has a definition. */
export type Defined = (label: string) => boolean;

const PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

const escapes = (s: string, i: number): boolean =>
  s[i] === "\\" && PUNCTUATION.test(s[i + 1] ?? "");

/** A run of `n` backticks at `i` closed by the next run of exactly `n`: the index after it, or null. */
function codeSpanEnd(s: string, i: number): number | null {
  const n = /^`+/.exec(s.slice(i))?.[0].length ?? 0;
  const close = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
  close.lastIndex = i + n;
  const m = close.exec(s);
  return m ? m.index + n : null;
}

/**
 * Spaces and tabs from `i`, with at most one line ending among them: the
 * index after them.
 */
export function spacing(s: string, i: number): number {
  let j = i;
  let newline = false;
  while (j < s.length) {
    const c = s[j];
    if (c === " " || c === "\t") j++;
    else if (c === "\n" && !newline) {
      newline = true;
      j++;
    } else break;
  }
  return j;
}

/**
 * Link text from the `[` at `i` to its matching `]`: brackets nest, an
 * escaped one does not count, and a code span's content is skipped.
 */
export function linkText(
  s: string,
  i: number,
): { text: string; end: number } | null {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (escapes(s, j)) j++;
    else if (s[j] === "`") j = (codeSpanEnd(s, j) ?? j + 1) - 1;
    else if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0)
      return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

/**
 * A link label from the `[` at `i`: no unescaped bracket inside, at most 999
 * characters. Empty for the `[]` of a collapsed reference.
 */
export function linkLabel(
  s: string,
  i: number,
): { text: string; end: number } | null {
  for (let j = i + 1; j < s.length && j - i <= 1000; j++) {
    if (escapes(s, j)) j++;
    else if (s[j] === "[") return null;
    else if (s[j] === "]") return { text: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

type Destination = { url: string; end: number } | null;

/** A destination in angle brackets at `i`: no line ending and no unescaped `<` or `>` inside. */
function angleDestination(s: string, i: number): Destination {
  for (let j = i + 1; j < s.length; j++) {
    if (escapes(s, j)) j++;
    else if (s[j] === "\n" || s[j] === "<") return null;
    else if (s[j] === ">") return { url: s.slice(i + 1, j), end: j + 1 };
  }
  return null;
}

const ends = (s: string, j: number): boolean =>
  s.charCodeAt(j) <= 0x20 || s.charCodeAt(j) === 0x7f;

/** A bare destination at `i`: no space or control character, its parentheses balanced. */
function bareDestination(s: string, i: number): Destination {
  let depth = 0;
  let j = i;
  for (; j < s.length && !ends(s, j); j++) {
    if (escapes(s, j)) j++;
    else if (s[j] === "(") depth++;
    else if (s[j] === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return j === i || depth > 0 ? null : { url: s.slice(i, j), end: j };
}

/**
 * A link destination at `i`: in angle brackets, or bare (not starting with
 * `<`).
 */
export const destination = (s: string, i: number): Destination =>
  s[i] === "<" ? angleDestination(s, i) : bareDestination(s, i);

const CLOSER: Record<string, string> = { '"': '"', "'": "'", "(": ")" };

/** A link title at `i`, in double quotes, single quotes or parentheses: the index after it. */
export function title(s: string, i: number): number | null {
  const closer = CLOSER[s[i] ?? ""];
  if (closer === undefined) return null;
  for (let j = i + 1; j < s.length; j++) {
    if (escapes(s, j)) j++;
    else if (s[i] === "(" && s[j] === "(") return null;
    else if (s[j] === closer)
      return /\n[ \t]*\n/.test(s.slice(i, j)) ? null : j + 1;
  }
  return null;
}

/** An inline link's `(destination "title")` from the `(` at `i`: the index after it. */
export function inlineLink(s: string, i: number): number | null {
  let j = spacing(s, i + 1);
  if (s[j] === ")") return j + 1;
  const dest = destination(s, j);
  if (!dest) return null;
  j = spacing(s, dest.end);
  if (j > dest.end && s[j] !== ")") {
    const end = title(s, j);
    if (end === null) return null;
    j = spacing(s, end);
  }
  return s[j] === ")" ? j + 1 : null;
}

/** Spaces and tabs from `i` to the end of its line: the index of that end, or null when text follows. */
function lineEnd(s: string, i: number): number | null {
  const j = i + (/^[ \t]*/.exec(s.slice(i))?.[0].length ?? 0);
  return j === s.length || s[j] === "\n" ? j : null;
}

/**
 * The link reference definition `s` opens with: up to three spaces, the label,
 * a colon, the destination and an optional title, each of the last two allowed
 * on a line of its own. A title followed by more text on its line is not part
 * of it, and then the definition ends with its destination when nothing
 * follows that on its line. `end` is where the definition's last line ends.
 */
export function definition(
  s: string,
): { name: string; url: string; end: number } | null {
  const start = /^ {0,3}\[/.exec(s)?.[0].length;
  const name = start === undefined ? null : linkLabel(s, start - 1);
  if (!name?.text.trim() || s[name.end] !== ":") return null;
  const dest = destination(s, spacing(s, name.end + 1));
  if (!dest) return null;
  const gap = spacing(s, dest.end);
  const titled = gap > dest.end ? title(s, gap) : null;
  const end =
    (titled === null ? null : lineEnd(s, titled)) ?? lineEnd(s, dest.end);
  return end === null ? null : { name: name.text, url: dest.url, end };
}

/** What a stretch of inline Markdown renders as. */
export type Token =
  | { kind: "text"; value: string }
  /** A backslash-escaped character: text that opens and closes nothing. */
  | { kind: "escaped"; value: string }
  | { kind: "code"; value: string }
  | { kind: "html" }
  | { kind: "link"; text: string; resolves: boolean };

const HTML = [
  /^<!--(?:-?>|[\s\S]*?-->)/,
  /^<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/,
  /^<\/[A-Za-z][A-Za-z0-9-]*\s*>/,
  /^<\?[\s\S]*?\?>/,
  /^<![A-Za-z][^>]*>/,
  /^<!\[CDATA\[[\s\S]*?\]\]>/,
];

const AUTOLINK =
  /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

/** The token a `<` at `i` opens, with the index after it; null when it is text. */
function angle(s: string, i: number): { token: Token; end: number } | null {
  const rest = s.slice(i);
  const auto = AUTOLINK.exec(rest)?.[0];
  if (auto)
    return {
      token: { kind: "link", text: auto.slice(1, -1), resolves: true },
      end: i + auto.length,
    };
  for (const html of HTML) {
    const m = html.exec(rest)?.[0];
    if (m) return { token: { kind: "html" }, end: i + m.length };
  }
  return null;
}

/**
 * The link whose text opens with the `[` at `i`: inline, full reference,
 * collapsed or shortcut. A reference that has no definition renders as its
 * literal text, so `resolves` is false; it is still read as one, since what
 * it was meant to be is what a check reports.
 */
function link(
  s: string,
  i: number,
  defined: Defined,
): { token: Token; end: number } | null {
  const text = linkText(s, i);
  if (!text) return null;
  const inline = s[text.end] === "(" ? inlineLink(s, text.end) : null;
  if (inline !== null)
    return {
      token: { kind: "link", text: text.text, resolves: true },
      end: inline,
    };
  const ref = s[text.end] === "[" ? linkLabel(s, text.end) : null;
  const named = ref && ref.text.trim() !== "" ? ref.text : text.text;
  return {
    token: { kind: "link", text: text.text, resolves: defined(named) },
    end: ref ? ref.end : text.end,
  };
}

/** The token that starts at `i`, other than plain text, with the index after it. */
function special(
  s: string,
  i: number,
  defined: Defined,
): { token: Token; end: number } | null {
  const c = s[i];
  if (escapes(s, i))
    return {
      token: { kind: "escaped", value: s[i + 1] as string },
      end: i + 2,
    };
  if (c === "`") {
    const end = codeSpanEnd(s, i);
    return end === null
      ? null
      : { token: { kind: "code", value: s.slice(i, end) }, end };
  }
  if (c === "<") return angle(s, i);
  if (c === "[") return link(s, i, defined);
  const image = c === "!" && s[i + 1] === "[" ? link(s, i + 1, defined) : null;
  // An image is not a link, whatever its destination.
  return image
    ? { token: { kind: "link", text: "", resolves: false }, end: image.end }
    : null;
}

/** One paragraph's inline Markdown as the tokens it renders. */
export function tokens(s: string, defined: Defined): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < s.length; ) {
    const read = special(s, i, defined);
    // A backtick run that opens no code span is literal text, all of it.
    const plain = read
      ? null
      : s[i] === "`"
        ? (/^`+/.exec(s.slice(i))?.[0] as string)
        : (s[i] as string);
    const last = out.at(-1);
    if (read) out.push(read.token);
    else if (last?.kind === "text") last.value += plain;
    else out.push({ kind: "text", value: plain as string });
    i = read ? read.end : i + (plain as string).length;
  }
  return out;
}

/** Text split into paragraphs at its blank lines. */
const paragraphsOf = (s: string): string[] => s.split(/\n[ \t]*\n/);

/**
 * The prose a reader sees in `s`: its text and its links' text, without code,
 * HTML or link destinations.
 */
export function prose(s: string, defined: Defined): string {
  return paragraphsOf(s)
    .map((p) =>
      tokens(p, defined)
        .map((t) =>
          t.kind === "text" || t.kind === "escaped"
            ? t.value
            : t.kind === "link"
              ? prose(t.text, defined)
              : " ",
        )
        .join(""),
    )
    .join("\n\n");
}

/**
 * `s` with each link as one mark (`\uE001` for a link that renders, `\uE002`
 * for one that does not), each code span as `\uE003` and raw HTML removed, so
 * a pattern over it sees structure rather than source.
 */
export function marked(s: string, defined: Defined): string {
  return paragraphsOf(s)
    .map((p) => tokens(p, defined).map(mark).join(""))
    .join("\n\n");
}

function mark(t: Token): string {
  switch (t.kind) {
    case "text":
      return t.value;
    case "escaped":
      return "\uE004";
    case "code":
      return "\uE003";
    case "html":
      return "";
    case "link":
      return t.resolves ? "\uE001" : "\uE002";
  }
}

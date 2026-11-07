/**
 * The element text of an XML document, read the way the XML 1.0
 * recommendation (https://www.w3.org/TR/xml/) reads it, for the readers
 * whose build file is XML (Maven's `pom.xml`). A document a conforming
 * parser refuses as not well-formed is refused here too, with an
 * `UnreadableError` naming what is wrong. Every `<` opens exactly one of the
 * grammar's markup productions, read to that production's end: a start,
 * end or empty-element tag, a comment, a CDATA section, a processing
 * instruction, the XML declaration or the document type declaration.
 * Anything else at a `<` is malformed markup. The text read is the
 * document's characters, decoded from its bytes by `xml-encoding.ts`, which
 * alone consumes the byte order mark: a U+FEFF left in the text is a
 * character, and outside the root element it makes the document unreadable.
 *
 * Not checked: the declarations inside a document type declaration's
 * internal subset are read to their ends, with quotes respected, but their
 * bodies are not checked against the DTD grammar. Nothing a DTD declares is
 * applied, so a reference to an entity it declares makes the document
 * unreadable. Neither changes the text of an element that is read.
 */
import { UnreadableError } from "./model.ts";

/** Element text by its path from the root (`project/build/…`). */
export type Values = Map<string, string>;

/** XML's white space: space, tab, carriage return and line feed. */
const S = "[ \\t\\r\\n]";
const NAME_START =
  ":A-Z_a-z\\u{C0}-\\u{D6}\\u{D8}-\\u{F6}\\u{F8}-\\u{2FF}\\u{370}-\\u{37D}\\u{37F}-\\u{1FFF}\\u{200C}-\\u{200D}\\u{2070}-\\u{218F}\\u{2C00}-\\u{2FEF}\\u{3001}-\\u{D7FF}\\u{F900}-\\u{FDCF}\\u{FDF0}-\\u{FFFD}\\u{10000}-\\u{EFFFF}";
/** XML's `Name` production. */
const NAME = `[${NAME_START}][${NAME_START}\\-.0-9\\u{B7}\\u{300}-\\u{36F}\\u{203F}-\\u{2040}]*`;
const ATTRIBUTE = `${S}+(${NAME})${S}*=${S}*("[^<"]*"|'[^<']*')`;
/** An attribute, capturing nothing, for a tag's own groups. */
const ATTRIBUTE_SHAPE = `${S}+${NAME}${S}*=${S}*(?:"[^<"]*"|'[^<']*')`;
const LITERAL = `(?:"[^"]*"|'[^']*')`;
const PUBID_CHARS = "\\-\\x20\\r\\na-zA-Z0-9()+,./:=?;!*#@$_%";
const PUBID = `(?:"[${PUBID_CHARS}']*"|'[${PUBID_CHARS}]*')`;
const pair = (name: string, value: string) =>
  `${S}+${name}${S}*=${S}*(?:"${value}"|'${value}')`;

const START_TAG = new RegExp(
  `<(${NAME})((?:${ATTRIBUTE_SHAPE})*)${S}*(/?)>`,
  "uy",
);
const ATTRIBUTES = new RegExp(ATTRIBUTE, "gu");
const END_TAG = new RegExp(`</(${NAME})${S}*>`, "uy");
const PI_TARGET = new RegExp(`<\\?(${NAME})(?=${S}|\\?>)`, "uy");
const ENC_NAME = "[A-Za-z][\\w.\\-]*";
/** XML's `XMLDecl` production, capturing the `encoding` it names. */
const XML_DECLARATION = new RegExp(
  `^<\\?xml${pair("version", "1\\.[0-9]+")}(?:${S}+encoding${S}*=${S}*(?:"(${ENC_NAME})"|'(${ENC_NAME})'))?(?:${pair("standalone", "(?:yes|no)")})?${S}*\\?>$`,
  "u",
);
const DOCTYPE = new RegExp(
  `<!DOCTYPE${S}+${NAME}(?:${S}+(?:SYSTEM${S}+${LITERAL}|PUBLIC${S}+${PUBID}${S}+${LITERAL}))?${S}*`,
  "uy",
);
const SUBSET_END = new RegExp(`\\]${S}*>`, "y");
const MARKUP_DECLARATION = new RegExp(
  `<!(?:ELEMENT|ATTLIST|ENTITY|NOTATION)${S}`,
  "y",
);
const PE_REFERENCE = new RegExp(`%${NAME};`, "uy");

/** A tag: whether it closes an element, the element's name, and whether it is empty (`<a/>`). */
export interface Tag {
  closing: boolean;
  name: string;
  empty: boolean;
}

/** The markup opening at a `<`: where it ends, which production it is, the text it adds, and the tag it is. */
interface Markup {
  end: number;
  kind: "tag" | "comment" | "cdata" | "pi" | "xml-declaration" | "doctype";
  adds: string;
  tag: Tag | null;
}

/** `re`'s match exactly at `at`, or null. */
function matchAt(re: RegExp, text: string, at: number) {
  re.lastIndex = at;
  return re.exec(text);
}

const malformed = (text: string, at: number) =>
  new UnreadableError(
    `has malformed markup (${JSON.stringify(text.slice(at, at + 20))})`,
  );

/** Where `closer` starts, searching from `from`; an `UnreadableError` naming `kind` when it never does. */
function closing(text: string, closer: string, from: number, kind: string) {
  const close = text.indexOf(closer, from);
  if (close === -1) throw new UnreadableError(`has ${kind} it never closes`);
  return close;
}

const markup = (kind: Markup["kind"], end: number): Markup => ({
  end,
  kind,
  adds: "",
  tag: null,
});

/** The markup at `open`, read by the production its opener names. */
function markupAt(text: string, open: number): Markup {
  if (text.startsWith("<!--", open))
    return markup("comment", commentEnd(text, open));
  if (text.startsWith("<![CDATA[", open)) {
    const close = closing(text, "]]>", open + 9, "a CDATA section");
    return { ...markup("cdata", close + 3), adds: text.slice(open + 9, close) };
  }
  if (text.startsWith("<?", open)) return instructionAt(text, open);
  if (text.startsWith("<!DOCTYPE", open))
    return markup("doctype", doctypeEnd(text, open));
  if (text.startsWith("<!", open)) throw malformed(text, open);
  return tagAt(text, open);
}

/** The end of the comment at `open`, which may hold no `--` and may not end in `-`. */
function commentEnd(text: string, open: number) {
  const close = closing(text, "-->", open + 4, "a comment (<!--)");
  const body = text.slice(open + 4, close);
  if (body.includes("--") || body.endsWith("-"))
    throw new UnreadableError("has a comment holding -- (<!-- -- -->)");
  return close + 3;
}

/** The processing instruction at `open`; its target `xml`, in any case, is the XML declaration. */
function instructionAt(text: string, open: number): Markup {
  const target = matchAt(PI_TARGET, text, open);
  if (!target) throw malformed(text, open);
  const end =
    closing(text, "?>", open + 2, "a processing instruction (<?)") + 2;
  if ((target[1] as string).toLowerCase() !== "xml") return markup("pi", end);
  if (!XML_DECLARATION.test(text.slice(open, end)))
    throw new UnreadableError(
      `has an XML declaration XML does not allow (${JSON.stringify(text.slice(open, end).slice(0, 40))})`,
    );
  return markup("xml-declaration", end);
}

/**
 * The `encoding` named by the XML declaration that opens `text`, read by
 * the same production `instructionAt` checks it against: null when `text`
 * opens with no XML declaration (another processing instruction such as
 * `<?xml-stylesheet …?>` is none), with one XML does not allow, or with one
 * that names no encoding. The declaration has no length bound, so it is
 * read to its `?>` however far that stands.
 */
export function declaredEncoding(text: string): string | null {
  const target = matchAt(PI_TARGET, text, 0);
  if (target?.[1] !== "xml") return null;
  const close = text.indexOf("?>", 2);
  if (close === -1) return null;
  const found = XML_DECLARATION.exec(text.slice(0, close + 2));
  return found ? (found[1] ?? found[2] ?? null) : null;
}

/** The end of the document type declaration at `open`, its internal subset included. */
function doctypeEnd(text: string, open: number) {
  const head = matchAt(DOCTYPE, text, open);
  if (!head) throw malformed(text, open);
  const at = open + head[0].length;
  if (text[at] === ">") return at + 1;
  if (text[at] !== "[") throw malformed(text, open);
  const close = subsetEnd(text, at + 1);
  const tail = matchAt(SUBSET_END, text, close);
  if (!tail) throw malformed(text, close);
  return close + tail[0].length;
}

/** Where the internal subset that starts at `at` ends, at its `]`. */
function subsetEnd(text: string, at: number) {
  for (;;) {
    while (/[ \t\r\n]/.test(text[at] ?? "")) at++;
    if (at >= text.length)
      throw new UnreadableError(
        "has a document type declaration (<!DOCTYPE) it never closes",
      );
    if (text[at] === "]") return at;
    at = subsetItemEnd(text, at);
  }
}

/** The end of one item of an internal subset: a declaration, a comment, a processing instruction or a parameter-entity reference. */
function subsetItemEnd(text: string, at: number) {
  if (text.startsWith("<!--", at)) return commentEnd(text, at);
  if (text.startsWith("<?", at)) {
    const pi = instructionAt(text, at);
    if (pi.kind !== "pi") throw malformed(text, at);
    return pi.end;
  }
  if (matchAt(MARKUP_DECLARATION, text, at)) return declarationEnd(text, at);
  const reference = matchAt(PE_REFERENCE, text, at);
  if (reference) return at + reference[0].length;
  throw malformed(text, at);
}

/** The end of the declaration at `open`: its `>`, past any `>` inside a quoted literal. */
function declarationEnd(text: string, open: number) {
  let quote = "";
  for (let i = open + 2; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) quote = c === quote ? "" : quote;
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  throw new UnreadableError("has a declaration (<!) it never closes");
}

/** The end tag or the start tag at `open`; a start tag's attributes are checked. */
function tagAt(text: string, open: number): Markup {
  const end = matchAt(END_TAG, text, open);
  if (end)
    return {
      ...markup("tag", open + end[0].length),
      tag: { closing: true, name: end[1] as string, empty: false },
    };
  const start = matchAt(START_TAG, text, open);
  if (!start) throw malformed(text, open);
  checkAttributes(start[2] as string);
  return {
    ...markup("tag", open + start[0].length),
    tag: { closing: false, name: start[1] as string, empty: start[3] === "/" },
  };
}

/** An `UnreadableError` for an attribute named twice or a value whose references XML does not read. */
function checkAttributes(list: string) {
  const seen = new Set<string>();
  for (const [, name, value] of list.matchAll(ATTRIBUTES)) {
    if (seen.has(name as string))
      throw new UnreadableError(`has the attribute ${name} twice on one tag`);
    seen.add(name as string);
    characterData((value as string).slice(1, -1));
  }
}

/** The elements read so far: their values, the path of those open, whether any opened, and whether a document type was declared. */
interface Scan {
  values: Values;
  path: string[];
  rooted: boolean;
  declared: boolean;
}

/**
 * The text of every element, keyed by its path, scanned from the start as
 * XML reads it: a comment adds nothing (`qa<!-- x -->/java` is `qa/java`),
 * a CDATA section adds its text, and markup inside either is not markup.
 * A character XML forbids makes the document unreadable wherever it stands,
 * in CDATA and comments too, and every reference is checked, in character
 * data and attribute values alike. Line ends are read as XML normalizes
 * them before parsing: a carriage return and line feed, or a carriage
 * return alone, is one line feed, while a `&#13;` reference stays a
 * carriage return.
 */
export function elementValues(source: string): Values {
  rejectForbiddenChars(source);
  const text = source.replace(/\r\n?/g, "\n");
  const scan: Scan = {
    values: new Map(),
    path: [],
    rooted: false,
    declared: false,
  };
  let value = "";
  let at = 0;
  for (
    let open = text.indexOf("<", at);
    open !== -1;
    open = text.indexOf("<", at)
  ) {
    const read = markupAt(text, open);
    const raw = text.slice(at, open);
    placed(scan, raw, read, open === 0);
    value += textData(raw) + read.adds;
    at = read.end;
    if (!read.tag) continue;
    onTag(scan, read.tag, value);
    value = "";
  }
  const { path } = scan;
  if (!path.length) outsideRoot(scan, text.slice(at), null);
  textData(text.slice(at));
  if (path.length)
    throw new UnreadableError(
      `leaves <${path[path.length - 1]}> open at the end of the file`,
    );
  if (!scan.rooted) throw new UnreadableError("has no root element");
  return scan.values;
}

/**
 * Whether `read`, after `raw` text, stands where XML allows it: the
 * document type declared once and before the root, and the XML
 * declaration only at the start of the file.
 */
function placed(scan: Scan, raw: string, read: Markup, first: boolean) {
  if (!scan.path.length) outsideRoot(scan, raw, read);
  if (read.kind === "doctype") {
    if (scan.rooted)
      throw new UnreadableError("has a declaration (<!) after the root opens");
    if (scan.declared)
      throw new UnreadableError(
        "has a second document type declaration (<!DOCTYPE)",
      );
    scan.declared = true;
  }
  if (read.kind === "xml-declaration" && !first)
    throw new UnreadableError(
      "has an XML declaration (<?xml) that does not open the file",
    );
}

/**
 * What stands outside the root element, before or after it: `raw` text and
 * then `read` (`null` at the end of the file). XML allows only white space,
 * comments and processing instructions there, a declaration before the
 * root, and exactly one root element.
 */
function outsideRoot(scan: Scan, raw: string, read: Markup | null) {
  if (/[^ \t\r\n]/.test(raw))
    throw new UnreadableError(
      `has text outside the root element (${JSON.stringify(raw.replace(/^[ \t\r\n]+/, "").slice(0, 20))})`,
    );
  if (read?.kind === "cdata")
    throw new UnreadableError("has a CDATA section outside the root element");
  if (read?.tag && !read.tag.closing && scan.rooted)
    throw new UnreadableError(`has a second root element (<${read.tag.name}>)`);
}

/** One tag read into `scan`; `value` is the text since the tag before. */
function onTag(scan: Scan, tag: Tag, value: string) {
  const { path } = scan;
  if (!tag.closing) {
    scan.rooted = true;
    if (!tag.empty) path.push(tag.name);
    return;
  }
  if (path[path.length - 1] !== tag.name)
    throw new UnreadableError(
      `closes <${tag.name}> where ${path.length ? `<${path[path.length - 1]}>` : "no element"} is open`,
    );
  scan.values.set(path.join("/"), value);
  path.pop();
}

/** The five references XML predefines. */
const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Whether `code` is a character XML allows: tab, line feed, carriage return, and the Unicode ranges outside surrogates, U+FFFE and U+FFFF. */
const isXmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

/** An `UnreadableError` for the first character XML forbids in `text`, a lone surrogate included. */
function rejectForbiddenChars(text: string) {
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (!isXmlChar(code))
      throw new UnreadableError(
        `has a character XML forbids (U+${code.toString(16).toUpperCase().padStart(4, "0")})`,
      );
  }
}

/** Character data between markup, which may not hold `]]>`, with its references replaced. */
function textData(raw: string): string {
  if (raw.includes("]]>"))
    throw new UnreadableError("has ]]> in character data");
  return characterData(raw);
}

/**
 * Text with its references replaced, as XML reads it (`qa&amp;checks` is
 * `qa&checks`). An entity a DTD would declare cannot be resolved from the
 * text alone, so it makes the document unreadable.
 */
function characterData(raw: string): string {
  return raw.replace(/&([^;&\s]*);?/g, (ref, name: string) => {
    if (!ref.endsWith(";"))
      throw new UnreadableError(`has an & that starts no reference (${ref})`);
    const numeric = /^#(?:x([\da-fA-F]+)|(\d+))$/.exec(name);
    if (numeric) {
      const code = numeric[1]
        ? Number.parseInt(numeric[1], 16)
        : Number(numeric[2]);
      if (!isXmlChar(code))
        throw new UnreadableError(`has a reference to no character (${ref})`);
      return String.fromCodePoint(code);
    }
    const predefined = Object.hasOwn(PREDEFINED, name)
      ? PREDEFINED[name]
      : undefined;
    if (predefined === undefined)
      throw new UnreadableError(
        `has an entity reference it cannot resolve (${ref})`,
      );
    return predefined;
  });
}

/**
 * The test cases and suites of a JUnit report, read by a strict XML parser.
 *
 * A gate that decides from a test report must know which cases ran, which
 * failed and which skipped, and must refuse a report it cannot read: a
 * report read loosely lets captured output that quotes a tag, a comment that
 * swallows a closing tag, or a tag the reader half-understood change the
 * count. So the report is parsed in document order, one construct at a time,
 * against the XML 1.0 grammar for a document without a DTD: the XML
 * declaration only at the start, comments, CDATA sections and processing
 * instructions where the grammar puts them, attributes separated by
 * whitespace with unique names and no `<` in a value, closing tags that are a
 * name alone, character data without `]]>`, only the five predefined
 * entities and character references to characters XML allows, line ends
 * normalized to LF before anything is read. A DOCTYPE is read by its own
 * grammar (a root name and at most one SYSTEM or PUBLIC identifier) and only
 * without an internal subset, since that subset can declare entities this
 * reader does not expand. Anything else is not well-formed and
 * throws.
 *
 * The JUnit tree is then read from the elements alone, so the text of a
 * comment, a CDATA section or captured output never counts. The root is a
 * <testsuites> or a single <testsuite>; a <testsuite> sits under the root or
 * another suite, a <testcase> directly under a <testsuite>, a <testsuites>
 * only as the root; a case skipped holds a <skipped> child, a case failed a
 * <failure> or an <error> child.
 */

/** One test case: its name, its class name, and its result. */
export interface JunitCase {
  name: string;
  classname: string;
  failed: boolean;
  skipped: boolean;
  /** The suites that hold it, as indexes into `JunitReport.suites`, outermost first. */
  suites: number[];
}

/** One suite, with the cases counted under it, nested suites included. */
export interface JunitSuite {
  name: string;
  /** 0 for a suite directly under the root, and for a root <testsuite>. */
  depth: number;
  executed: number;
  skipped: number;
  /** What its `tests` attribute declared, when that is a count. */
  declaredTests: number | undefined;
}

export interface JunitReport {
  /** Every suite, in document order. */
  suites: JunitSuite[];
  /** Every case, in document order. */
  cases: JunitCase[];
  /** What a root <testsuites> declared in its `tests` attribute, when that is a count. */
  rootDeclaredTests: number | undefined;
}

/** A report this reader could not read: not well-formed, or not JUnit. */
export class JunitReportError extends Error {
  override name = "JunitReportError";
}

interface Element {
  name: string;
  attributes: Map<string, string>;
  children: Element[];
}

const NAME_START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NAME = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, "uy");
const SPACE = /[ \t\r\n]+/y;
const XML_CHARS = /^[\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]*$/u;
const isXmlChar = (code: number) =>
  code <= 0x10ffff && XML_CHARS.test(String.fromCodePoint(code));
const PREDEFINED = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
/** A DOCTYPE's public identifier: the characters XML allows in a PubidLiteral. */
const PUBID = /^[ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/;
const REFERENCE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([^;&\s<]*));/y;
const XML_DECLARATION =
  /<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.[0-9]+"|'1\.[0-9]+')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/y;

/** A single-pass reader over the document text. */
class Parser {
  at = 0;
  readonly text: string;
  /** Line ends are normalized first, as XML requires: CRLF and a lone CR read as LF. */
  constructor(text: string) {
    this.text = text.replace(/\r\n?/g, "\n");
  }

  fail(problem: string, at = this.at): never {
    throw new JunitReportError(
      `not well-formed XML: ${problem} at offset ${at}`,
    );
  }

  startsWith(literal: string): boolean {
    return this.text.startsWith(literal, this.at);
  }

  expect(literal: string, what: string): void {
    if (!this.startsWith(literal)) this.fail(`expected ${what}`);
    this.at += literal.length;
  }

  match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.at;
    const m = pattern.exec(this.text);
    if (m) this.at = pattern.lastIndex;
    return m;
  }

  space(): boolean {
    return this.match(SPACE) !== null;
  }

  name(what: string): string {
    const m = this.match(NAME);
    if (!m) this.fail(`expected ${what}`);
    return m[0];
  }

  /** The index of `terminator` from here, or a failure naming the open construct. */
  until(terminator: string, what: string): number {
    const end = this.text.indexOf(terminator, this.at);
    if (end < 0) this.fail(`${what} is never closed`);
    return end;
  }

  comment(): void {
    const start = this.at;
    this.at += 4;
    const end = this.until("--", "a comment");
    if (!this.text.startsWith("-->", end))
      this.fail("a comment holds --", start);
    this.at = end + 3;
  }

  processingInstruction(): void {
    const start = this.at;
    this.at += 2;
    const target = this.name("a processing-instruction target");
    if (target.toLowerCase() === "xml")
      this.fail("an XML declaration not at the start", start);
    if (!this.startsWith("?>") && !this.space())
      this.fail("expected whitespace after the processing-instruction target");
    this.at = this.until("?>", "a processing instruction") + 2;
  }

  cdata(): void {
    this.at = this.until("]]>", "a CDATA section") + 3;
  }

  /**
   * A DOCTYPE without an internal subset: the root name, then at most one
   * external identifier, `SYSTEM "uri"` or `PUBLIC "pubid" "uri"`.
   */
  doctype(): void {
    const start = this.at;
    this.at += "<!DOCTYPE".length;
    if (!this.space()) this.fail("expected whitespace after <!DOCTYPE");
    this.name("the DOCTYPE's root name");
    const spaced = this.space();
    if (spaced && this.startsWith("SYSTEM")) {
      this.at += "SYSTEM".length;
      this.doctypeLiteral();
    } else if (spaced && this.startsWith("PUBLIC")) {
      this.at += "PUBLIC".length;
      const pubid = this.doctypeLiteral();
      if (!PUBID.test(pubid))
        this.fail("a public identifier holding a character it may not", start);
      this.doctypeLiteral();
    }
    this.space();
    if (this.startsWith("["))
      this.fail(
        "a DOCTYPE with an internal subset, whose entities this reader does not expand,",
        start,
      );
    if (this.at >= this.text.length)
      this.fail("a DOCTYPE is never closed", start);
    this.expect(
      ">",
      "> to end the DOCTYPE after its root name and external identifier",
    );
  }

  /** Whitespace, then a quoted literal of a DOCTYPE's external identifier: its text. */
  doctypeLiteral(): string {
    if (!this.space())
      this.fail("expected whitespace before a DOCTYPE literal");
    const quote = this.text[this.at];
    if (quote !== '"' && quote !== "'")
      this.fail("expected a quoted DOCTYPE literal");
    const from = this.at + 1;
    this.at = from;
    const end = this.until(quote, "a DOCTYPE literal");
    this.at = end + 1;
    return this.text.slice(from, end);
  }

  /** Comments, processing instructions and whitespace, outside the root element. */
  misc(): void {
    for (;;) {
      if (this.space()) continue;
      if (this.startsWith("<!--")) this.comment();
      else if (this.startsWith("<?")) this.processingInstruction();
      else return;
    }
  }

  /** Check a reference at `&` and return the text it stands for. */
  reference(): string {
    const start = this.at;
    const m = this.match(REFERENCE);
    if (!m) this.fail("an unterminated entity reference");
    const [, hex, decimal, named] = m;
    if (hex !== undefined || decimal !== undefined) {
      const code = hex ? Number.parseInt(hex, 16) : Number(decimal);
      if (!isXmlChar(code)) this.fail(`${m[0]} names no XML character`, start);
      return String.fromCodePoint(code);
    }
    const value = PREDEFINED.get(named ?? "");
    if (value === undefined)
      this.fail(`the unknown entity reference ${m[0]}`, start);
    return value;
  }

  attributeValue(): string {
    const quote = this.text[this.at];
    if (quote !== '"' && quote !== "'")
      this.fail("expected a quoted attribute value");
    this.at++;
    let value = "";
    for (let piece = this.valuePiece(quote); piece !== null; )
      [value, piece] = [value + piece, this.valuePiece(quote)];
    return value;
  }

  /** The next piece of an attribute value, or null past its closing quote. */
  valuePiece(quote: string): string | null {
    const c = this.text[this.at];
    if (c === undefined) this.fail("an attribute value is never closed");
    if (c === "<") this.fail("a < inside an attribute value");
    if (c === "&") return this.reference();
    this.at++;
    if (c === quote) return null;
    return c === "\t" || c === "\n" ? " " : c;
  }

  /** A start tag from its `<`: the element, and whether it closed itself. */
  startTag(): { element: Element; empty: boolean } {
    this.at++;
    const element: Element = {
      name: this.name("an element name"),
      attributes: new Map(),
      children: [],
    };
    for (;;) {
      const spaced = this.space();
      if (this.startsWith("/>")) {
        this.at += 2;
        return { element, empty: true };
      }
      if (this.startsWith(">")) {
        this.at++;
        return { element, empty: false };
      }
      if (!spaced) this.fail("expected whitespace before an attribute");
      const start = this.at;
      const name = this.name("an attribute name");
      this.space();
      this.expect("=", "= after an attribute name");
      this.space();
      if (element.attributes.has(name))
        this.fail(`attribute ${name} is repeated`, start);
      element.attributes.set(name, this.attributeValue());
    }
  }

  /** Character data up to the next `<`, with its references checked. */
  charData(): void {
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined || c === "<") return;
      if (c === "&") this.reference();
      else if (c === "]" && this.startsWith("]]>"))
        this.fail("]]> in character data");
      else this.at++;
    }
  }

  /** The root element and everything in it. */
  element(): Element {
    const { element: root, empty } = this.startTag();
    const open: Element[] = empty ? [] : [root];
    for (let parent = open.at(-1); parent; parent = open.at(-1)) {
      this.charData();
      if (this.at >= this.text.length)
        this.fail(`<${parent.name}> is never closed`);
      this.content(parent, open);
    }
    return root;
  }

  /** One construct inside `parent`, at a `<`; an element opens or closes on `open`. */
  content(parent: Element, open: Element[]): void {
    if (this.startsWith("</")) {
      this.endTag(parent);
      open.pop();
    } else if (this.startsWith("<!--")) this.comment();
    else if (this.startsWith("<![CDATA[")) this.cdata();
    else if (this.startsWith("<?")) this.processingInstruction();
    else if (this.startsWith("<!DOCTYPE"))
      this.fail("a DOCTYPE inside an element");
    else if (this.startsWith("<!"))
      this.fail("a declaration inside an element");
    else {
      const { element, empty } = this.startTag();
      parent.children.push(element);
      if (!empty) open.push(element);
    }
  }

  /** A closing tag, which must close `parent`. */
  endTag(parent: Element): void {
    const start = this.at;
    this.at += 2;
    const name = this.name("an element name after </");
    this.space();
    this.expect(">", `> to end </${name}`);
    if (name !== parent.name)
      this.fail(`</${name}> closes <${parent.name}>`, start);
  }

  document(): Element {
    if (!XML_CHARS.test(this.text))
      throw new JunitReportError(
        "not well-formed XML: a character XML does not allow",
      );
    this.prolog();
    if (!this.text.includes("<", this.at))
      throw new JunitReportError("not a JUnit report: no element");
    this.outsideRoot();
    const root = this.element();
    this.misc();
    if (this.at < this.text.length) {
      if (this.startsWith("</")) this.fail("a closing tag that closes nothing");
      this.outsideRoot();
      this.fail("a second element after the root element");
    }
    return root;
  }

  /** A byte-order mark, the XML declaration, then comments, processing instructions and one DOCTYPE. */
  prolog(): void {
    if (this.startsWith("\uFEFF")) this.at++;
    const declared =
      this.startsWith("<?xml") &&
      /[ \t\r\n?]/.test(this.text[this.at + 5] ?? "");
    if (declared && !this.match(XML_DECLARATION))
      this.fail("a malformed XML declaration");
    this.misc();
    if (this.startsWith("<!DOCTYPE")) {
      this.doctype();
      this.misc();
    }
  }

  /** Refuse what may not stand outside the root element, where the root would start or after it ends. */
  outsideRoot(): void {
    if (!this.startsWith("<")) this.fail("text outside the root element");
    if (this.startsWith("<![CDATA["))
      this.fail("a CDATA section outside the root element");
    if (this.startsWith("<!DOCTYPE")) this.fail("a DOCTYPE out of place");
    if (this.startsWith("<!")) this.fail("a declaration out of place");
  }
}

/** Where a JUnit element may stand: the enclosing element, where none means only as the root. */
const PARENTS: Record<string, readonly string[]> = {
  testsuites: [],
  testsuite: ["testsuites", "testsuite"],
  testcase: ["testsuite"],
};

/** A `tests="N"` attribute as a count; absent or not a count gives undefined. */
function declaredTests(element: Element): number | undefined {
  const value = element.attributes.get("tests");
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

const hasChild = (element: Element, ...names: string[]) =>
  element.children.some((child) => names.includes(child.name));

/** Refuse a suite or a case anywhere JUnit does not put one. */
function checkPlaces(element: Element, parent: string | undefined): void {
  const allowed = PARENTS[element.name];
  if (allowed && parent !== undefined && !allowed.includes(parent))
    throw new JunitReportError(
      `not a JUnit report: a <${element.name}> inside a <${parent}>`,
    );
  for (const child of element.children) checkPlaces(child, element.name);
}

/** A suite open around the element being read, with its index in `JunitReport.suites`. */
type Open = { index: number; suite: JunitSuite }[];

/** Record one case, counted into every suite that holds it. */
function readCase(element: Element, open: Open, report: JunitReport): void {
  const skipped = hasChild(element, "skipped");
  report.cases.push({
    name: element.attributes.get("name") ?? "",
    classname: element.attributes.get("classname") ?? "",
    failed: hasChild(element, "failure", "error"),
    skipped,
    suites: open.map((o) => o.index),
  });
  for (const { suite } of open) suite[skipped ? "skipped" : "executed"]++;
}

/** The suites open inside `element`: those around it, and itself when it is a suite. */
function suitesWithin(element: Element, open: Open, report: JunitReport): Open {
  if (element.name !== "testsuite") return open;
  const suite: JunitSuite = {
    name: element.attributes.get("name") ?? "(unnamed)",
    depth: open.length,
    executed: 0,
    skipped: 0,
    declaredTests: declaredTests(element),
  };
  return [...open, { index: report.suites.push(suite) - 1, suite }];
}

function readSuites(element: Element, open: Open, report: JunitReport): void {
  if (element.name === "testcase") {
    readCase(element, open, report);
    return;
  }
  const within = suitesWithin(element, open, report);
  for (const child of element.children) readSuites(child, within, report);
}

/** The suites and cases of one JUnit report; throws a JunitReportError on one it cannot read. */
export function parseJunitReport(text: string): JunitReport {
  if (!text.trim()) throw new JunitReportError("the report is empty");
  const root = new Parser(text).document();
  if (root.name !== "testsuites" && root.name !== "testsuite")
    throw new JunitReportError(
      `not a JUnit report: the root element is <${root.name}>`,
    );
  checkPlaces(root, undefined);
  const report: JunitReport = {
    suites: [],
    cases: [],
    rootDeclaredTests:
      root.name === "testsuites" ? declaredTests(root) : undefined,
  };
  readSuites(root, [], report);
  return report;
}

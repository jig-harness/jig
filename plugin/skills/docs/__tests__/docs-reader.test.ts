// The exhaustive list of the frontmatter subset the M4 scripts read: one
// fixture per supported construct, and one per rejected construct with the
// message it gives.
import { describe, expect, test } from "bun:test";
import {
  decomment,
  type FieldValue,
  frontmatterValue,
  hasValue,
  isDate,
  readFrontmatter,
  linesWithBreaks,
  readScalar,
  splitLines,
} from "../scripts/lib/docs";

const doc = (...lines: string[]) =>
  ["---", ...lines, "---", "", "Body."].join("\n");

const supported: [string, string[], string, FieldValue][] = [
  [
    "U+00A0 before '#' is content, not a comment",
    ["status: approved\u00a0#draft"],
    "status",
    "approved\u00a0#draft",
  ],
  [
    "a trailing U+00A0 is content, not whitespace",
    ["last_updated: 2026-02-01\u00a0"],
    "last_updated",
    "2026-02-01\u00a0",
  ],
  [
    "a bare CR ends a line",
    ["description: |-", "  one\r  two"],
    "description",
    "one\ntwo",
  ],
  ["plain scalar", ["title: Plain text"], "title", "Plain text"],
  [
    "apostrophe inside a plain value",
    ["title: The team's guide"],
    "title",
    "The team's guide",
  ],
  ["trailing comment", ["status: active # current"], "status", "active"],
  [
    "apostrophe inside a plain value, then a comment",
    ["title: The team's guide # note"],
    "title",
    "The team's guide",
  ],
  [
    "'#' without a space before it is text",
    ["title: issue#4"],
    "title",
    "issue#4",
  ],
  [
    "double-quoted, '#' kept",
    ['title: "Caching # layer"'],
    "title",
    "Caching # layer",
  ],
  ["single-quoted, quotes stripped", ["title: 'Caching'"], "title", "Caching"],
  ["quoted value is never decoded", ['title: "a\\tb"'], "title", "a\\tb"],
  ["quoted value with a trailing comment", ['title: "x" # note'], "title", "x"],
  ["null is absent", ["owner: null"], "owner", null],
  ["~ is absent", ["owner: ~"], "owner", null],
  ["empty is absent", ["owner:"], "owner", null],
  ["comment-only value is absent", ["owner: # later"], "owner", null],
  ['quoted "null" is the text null', ['owner: "null"'], "owner", "null"],
  ["inline list", ["tags: [a, b]"], "tags", ["a", "b"]],
  [
    "inline list, comma inside quotes",
    ['tags: ["a, b", c]'],
    "tags",
    ["a, b", "c"],
  ],
  [
    "inline list, escaped quote inside a quoted member",
    ['tags: ["a \\"b, c", d]'],
    "tags",
    ['a \\"b, c', "d"],
  ],
  [
    "inline list, apostrophe inside a plain member",
    ["tags: [team's, b] # note"],
    "tags",
    ["team's", "b"],
  ],
  [
    "plain value starting with '-' and text",
    ["title: -flag"],
    "title",
    "-flag",
  ],
  ["inline list, trailing comma", ["tags: [a, ]"], "tags", ["a"]],
  ["empty inline list", ["tags: []"], "tags", []],
  ["block sequence", ["tags:", "  - a", "  - 'b' # note"], "tags", ["a", "b"]],
  [
    "block sequence after a comment line",
    ["tags:", "  # first", "  - a"],
    "tags",
    ["a"],
  ],
  [
    "literal block scalar",
    ["description: |", "  one", "  two"],
    "description",
    "one\ntwo\n",
  ],
  [
    "literal block scalar keeps indentation past its own",
    ["description: |-", "  one", "    two"],
    "description",
    "one\n  two",
  ],
  [
    "folded block scalar keeps paragraph breaks",
    ["description: >", "  one", "  two", "", "  three"],
    "description",
    "one two\nthree\n",
  ],
  [
    "folded block scalar keeps more-indented lines on their own",
    ["description: >-", "  one", "    code", "  two"],
    "description",
    "one\n  code\ntwo",
  ],
  [
    "keep chomping keeps the trailing blank lines",
    ["description: |+", "  one", ""],
    "description",
    "one\n\n",
  ],
  [
    "folded block scalar",
    ["description: >-", "  one", "  two"],
    "description",
    "one two",
  ],
  [
    "block scalar with indentation digit",
    ["description: |2-", "   deep"],
    "description",
    " deep",
  ],
  [
    "a whitespace-only line keeps the spaces past the block's indentation",
    ["description: |-", "  first", "    ", "  second"],
    "description",
    "first\n  \nsecond",
  ],
  [
    "a tab after a block scalar's indentation is content",
    ["description: |-", "  \ttext"],
    "description",
    "\ttext",
  ],
  [
    "a comment indented less than the content ends the block",
    ["description: |", "    text", "  # trailing", "title: x"],
    "description",
    "text\n",
  ],
  [
    "block scalar with no content is absent",
    ["description: |", "title: x"],
    "description",
    null,
  ],
];

describe("supported constructs", () => {
  for (const [label, lines, key, want] of supported)
    test(label, () => {
      const frontmatter = readFrontmatter(doc(...lines));
      expect(frontmatter.errors).toEqual([]);
      expect(frontmatter.fields.get(key) ?? null).toEqual(want);
    });
});

const rejected: [string, string[], string][] = [
  ["tab in indentation", ["tags:", "\t- a"], "line 3: tab in indentation"],
  [
    "anchor",
    ["title: &t Text"],
    "line 2: anchors and aliases are not supported",
  ],
  ["alias", ["title: *t"], "line 2: anchors and aliases are not supported"],
  [
    "explicit tag",
    ["title: !!str 5"],
    "line 2: explicit tags are not supported",
  ],
  [
    "explicit key",
    ["? title", ": Text"],
    "line 2: explicit keys (? key) are not supported",
  ],
  [
    "flow mapping",
    ["owner: {name: a}"],
    "line 2: flow mappings {…} are not supported",
  ],
  [
    "nested mapping",
    ["owner:", "  name: a"],
    "line 3: nested mappings under 'owner' are not supported",
  ],
  [
    "multiline plain scalar",
    ["title: First", "  second"],
    "line 3: a plain value cannot continue on the next line",
  ],
  [
    "duplicate key",
    ["status: draft", "status: approved"],
    "line 3: duplicate key 'status'",
  ],
  [
    "unterminated double quote",
    ['title: "Open'],
    "line 2: unterminated quoted value",
  ],
  [
    "unterminated single quote",
    ["title: 'Open"],
    "line 2: unterminated quoted value",
  ],
  [
    "text after a closing quote",
    ['title: "a" b'],
    "line 2: text after the closing quote",
  ],
  [
    "unsupported block scalar header",
    ["description: |-2"],
    "unsupported block scalar header '|-2'",
  ],
  [
    "zero indentation digit",
    ["description: |0"],
    "unsupported block scalar header '|0'",
  ],
  [
    "':' inside a plain value",
    ["title: Caching: a guide"],
    "a plain value cannot contain ': '",
  ],
  ["quoted key", ['"status": draft'], "line 2: quoted keys are not supported"],
  [
    "key without a space after ':'",
    ["title:x"],
    "line 2: not a `key: value` line",
  ],
  [
    "unterminated inline list",
    ["tags: [a, b"],
    "line 2: unterminated inline list",
  ],
  [
    "empty slot in an inline list",
    ["tags: [a,, b]"],
    "line 2: empty list member",
  ],
  [
    "nested inline list",
    ["tags: [[a]]"],
    "line 2: a nested list is not supported",
  ],
  ["reserved '@' start", ["title: @name"], "'@' is reserved"],
  ["reserved '`' start", ["title: `x`"], "'`' is reserved"],
  ["'%' start", ["title: %x"], "'%' cannot start a plain value"],
  ["']' start", ["title: ]x"], "']' cannot start a plain value"],
  ["'}' start", ["title: }x"], "'}' cannot start a plain value"],
  ["',' start", ["title: ,x"], "',' cannot start a plain value"],
  [
    "unknown escape in a double-quoted value",
    ['title: "a \\q b"'],
    "'\\q' is not a YAML escape",
  ],
  [
    "a hexadecimal escape without its digits",
    ['tags: ["\\xZZ"]'],
    "'\\x' is not a YAML escape",
  ],
  [
    "'- ' start of a value",
    ["title: - value"],
    "'- ' cannot start a plain value",
  ],
  [
    "flow indicator inside a plain list member",
    ["related: [a[b]]"],
    "a plain list member cannot contain [ ] { }",
  ],
  [
    "empty block member",
    ["tags:", "  - a", "  -"],
    "line 4: empty list member of 'tags'",
  ],
  [
    "misaligned block members",
    ["tags:", "  - a", "   - b"],
    "line 4: list members of 'tags' are not aligned",
  ],
  [
    "list members at column 0",
    ["tags:", "- a"],
    "line 3: list members must be indented under their key",
  ],
  [
    "block scalar as a list member",
    ["tags:", "  - |", "    text"],
    "line 3: a block scalar is supported only as a key's own value",
  ],
  [
    "under-indented block scalar",
    ["description: |2", "  ok", " short"],
    "under-indented",
  ],
  [
    "a control character in a plain value",
    ["title: A\u0001B"],
    "U+0001 is not allowed in YAML",
  ],
  [
    "a control character in a quoted value",
    ['title: "A\u0001B"'],
    "U+0001 is not allowed in YAML",
  ],
  [
    "a control character in a block scalar",
    ["description: |", "  A\u0001B"],
    "U+0001 is not allowed in YAML",
  ],
  ["DEL in a comment", ["title: A # \u007f"], "U+007F is not allowed in YAML"],
];

describe("rejected constructs", () => {
  for (const [label, lines, message] of rejected)
    test(label, () => {
      const errors = readFrontmatter(doc(...lines)).errors.join("\n");
      expect(errors).toContain(message);
    });
});

describe("the block itself", () => {
  test("a document without a leading --- has no frontmatter", () => {
    const frontmatter = readFrontmatter("# Title\n\n---\ntitle: x\n---\n");
    expect(frontmatter.present).toBe(false);
    expect(frontmatter.fields.size).toBe(0);
  });
  test("the block ends at the next --- line, and the body is not read", () => {
    const frontmatter = readFrontmatter(
      doc("title: x").replace("Body.", "title: y"),
    );
    expect(frontmatter.end).toBe(2);
    expect(frontmatter.fields.get("title")).toBe("x");
  });
  test("a control character in the body is not the reader's to judge", () => {
    const text = ["---", "title: T", "---", "", "Body \u0000 text."].join("\n");
    expect(readFrontmatter(text).errors).toEqual([]);
  });
  test("an unclosed block reports end -1", () => {
    expect(readFrontmatter("---\ntitle: x\n").end).toBe(-1);
  });
});

describe("helpers", () => {
  test("frontmatterValue gives text for scalars and lists, '' for absent", () => {
    const text = doc("title: x", "tags: [a, b]", "owner: ~");
    expect(frontmatterValue(text, "title")).toBe("x");
    expect(frontmatterValue(text, "tags")).toBe("a, b");
    expect(frontmatterValue(text, "owner")).toBe("");
    expect(frontmatterValue(text, "missing")).toBe("");
  });
  test("frontmatterValue refuses present but unreadable frontmatter, naming the document", () => {
    expect(() =>
      frontmatterValue(doc("related: &a [x]"), "related", "a.md"),
    ).toThrow("a.md: unreadable frontmatter");
    expect(() => frontmatterValue("---\ntitle: x\n", "title")).toThrow(
      "never closes",
    );
    expect(frontmatterValue("# No frontmatter\n", "title")).toBe("");
  });
  test("hasValue: blank quoted text is absent, an empty list is present", () => {
    expect(hasValue("  ")).toBe(false);
    expect(hasValue(null)).toBe(false);
    expect(hasValue([])).toBe(true);
  });
  test("isDate: a real calendar date, years 0-99 included", () => {
    expect(isDate("0099-01-01")).toBe(true);
    expect(isDate("0004-02-29")).toBe(true);
    expect(isDate("1900-02-29")).toBe(false);
    expect(isDate("2026-02-30")).toBe(false);
  });
  test("a double-quoted value keeps its valid escapes undecoded", () => {
    const value = String.raw`"\\ \" \t \x41 é \U0001F600"`;
    expect(readScalar(value)).toEqual({ value: value.slice(1, -1) });
  });
  test("decomment keeps a '#' inside quotes and cuts one after a space", () => {
    expect(decomment('"a \\" # b" # c')).toBe('"a \\" # b"');
    expect(decomment("2026-08-01 # note")).toBe("2026-08-01");
  });
});

// Block scalars are where a hand-written reader most easily drifts from YAML,
// so they are checked against a real parser over every combination of a set
// of line shapes: the reader must give the parser's value or an error, never
// a different value. An empty block is the one deliberate difference: the
// reader reads it as absent.
describe("block scalars agree with a YAML parser", () => {
  const HEADERS = ["|", "|-", "|+", ">", ">-", ">+", "|2", ">1-"];
  const SHAPES = [
    "  a",
    "    b",
    "   c",
    "",
    "  ",
    "     ",
    "  # c",
    " # d",
    "# e",
    "  \tf",
    "\tg",
    "  \t",
    "  \u00a0h",
    "  i\r  j",
  ];
  const sequences = (length: number): string[][] =>
    length === 0
      ? [[]]
      : sequences(length - 1).flatMap((s) => SHAPES.map((x) => [...s, x]));
  const cases = [1, 2, 3, 4].flatMap(sequences);

  test(`${HEADERS.length * cases.length} blocks read as the parser reads them, or are rejected`, async () => {
    const { load } = await import("../../../shared/vendor/js-yaml.mjs");
    const misread: string[] = [];
    for (const header of HEADERS)
      for (const lines of cases) {
        const yaml = [`description: ${header}`, ...lines, "next: x"];
        const ours = readFrontmatter(doc(...yaml));
        if (ours.errors.length) continue;
        let theirs: Record<string, unknown>;
        try {
          theirs = load(yaml.join("\n")) as Record<string, unknown>;
        } catch {
          misread.push(`${JSON.stringify(yaml)}: accepted, parser rejects`);
          continue;
        }
        const want = theirs.description;
        const got = ours.fields.get("description");
        const same =
          got === want ||
          (got === null && typeof want === "string" && !want.trim());
        if (!same || ours.fields.get("next") !== theirs.next)
          misread.push(
            `${JSON.stringify(yaml)}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`,
          );
      }
    expect(misread.slice(0, 10)).toEqual([]);
  });
});

// The same check over one-line values, plain, quoted and in a flow list,
// built from the characters a scalar reader most easily misreads: YAML's
// disallowed control characters, a bare CR, and U+00A0, which JavaScript
// counts as whitespace and YAML does not. Every value and every list member
// is compared in its own style: a plain one must be the parser's value, and a
// quoted one, which the reader keeps undecoded, must be exactly the text
// between its quotes, which the parser decodes to its value.
type Load = (text: string) => unknown;

const startsWhite = /^[ \t]+/;

/**
 * One flow-list member as written: a quote opens a scalar only as its first
 * character, and inside one `''` (single) or a backslash pair (double) does
 * not close it; the member runs to the next `,` or `]` outside quotes.
 */
const MEMBER = /[ \t]*(?:'(?:[^']|'')*'|"(?:[^"\\]|\\[\s\S])*")?[^,\]]*/y;

/** The flow list's members as written, from its opening `[` to the matching `]`. */
function flowMembers(list: string): string[] {
  const members: string[] = [];
  MEMBER.lastIndex = 1;
  for (;;) {
    members.push(MEMBER.exec(list)?.[0] ?? "");
    if (list[MEMBER.lastIndex] !== ",") break;
    MEMBER.lastIndex += 1;
  }
  // A trailing comma adds no member, and `[ ]` has none.
  if (!members.at(-1)?.replace(startsWhite, "")) members.pop();
  return members;
}

/** One scalar, written as `source`, read as `got`, agrees with the parser's `want`. */
function scalarAgrees(
  load: Load,
  source: string,
  got: unknown,
  want: unknown,
): boolean {
  const text = source.replace(startsWhite, "");
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return String(got) === String(want);
  const quoted = `${quote}${String(got)}${quote}`;
  if (typeof got !== "string" || !text.startsWith(quoted)) return false;
  try {
    return load(quoted) === want;
  } catch {
    return false;
  }
}

/** The reader's value for `source` agrees with the parser's, list members one by one. */
function agrees(
  load: Load,
  source: string,
  got: unknown,
  want: unknown,
): boolean {
  if (Array.isArray(want)) {
    const members = flowMembers(source.replace(startsWhite, ""));
    return (
      Array.isArray(got) &&
      got.length === want.length &&
      members.length === want.length &&
      want.every((member, i) =>
        scalarAgrees(load, members[i] ?? "", got[i], member),
      )
    );
  }
  return !Array.isArray(got) && scalarAgrees(load, source, got, want);
}

/** How the reader misreads `line`, or undefined when it agrees or rejects it. */
function misreading(load: Load, key: string, line: string): string | undefined {
  const ours = readFrontmatter(doc(line, "next: x"));
  if (ours.errors.length) return undefined;
  let theirs: Record<string, unknown>;
  try {
    theirs = load(`${line}\nnext: x`) as Record<string, unknown>;
  } catch {
    return `${JSON.stringify(line)}: accepted, parser rejects`;
  }
  const got = ours.fields.get(key);
  const source = line.slice(`${key}:`.length);
  if (
    ours.fields.get("next") === theirs.next &&
    agrees(load, source, got, theirs[key])
  )
    return undefined;
  return `${JSON.stringify(line)}: ${JSON.stringify(got)} vs ${JSON.stringify(theirs[key])}`;
}

describe("one-line values agree with a YAML parser", () => {
  const ALPHABET = [
    "a",
    " ",
    "#",
    ":",
    "'",
    '"',
    "\\",
    "-",
    "[",
    "]",
    ",",
    "\u0001",
    "\u007f",
    "\t",
    "\u0085",
    "\u00a0",
    "\r",
  ];
  const strings = (length: number): string[] =>
    length === 0
      ? [""]
      : strings(length - 1).flatMap((s) => ALPHABET.map((c) => s + c));
  // A CR before `---` starts a line that closes the frontmatter: not a value.
  const values = [1, 2, 3, 4]
    .flatMap(strings)
    .filter((v) => !v.includes("\r---"));
  const forms = (v: string) => [
    ["title", `title: ${v}`],
    ["tags", `tags: [${v}]`],
    ["title", `title: "${v}"`],
    ["title", `title: '${v}'`],
  ];

  test(`${values.length * 4} values read as the parser reads them, or are rejected`, async () => {
    const { load } = await import("../../../shared/vendor/js-yaml.mjs");
    const misread = values
      .flatMap((value) =>
        forms(value).map(([key = "", line = ""]) =>
          misreading(load, key, line),
        ),
      )
      .filter(Boolean);
    expect(misread.slice(0, 10)).toEqual([]);
  });
});

describe("lines with their breaks", () => {
  const cases: [string, string[]][] = [
    ["", []],
    ["a", ["a"]],
    ["a\n", ["a\n"]],
    ["a\r\nb\rc\nd", ["a\r\n", "b\r", "c\n", "d"]],
    ["\n\r\n\r", ["\n", "\r\n", "\r"]],
    ["a\n\nb\r\n", ["a\n", "\n", "b\r\n"]],
  ];
  for (const [text, lines] of cases)
    test(JSON.stringify(text), () => {
      expect(linesWithBreaks(text)).toEqual(lines);
      expect(linesWithBreaks(text).join("")).toBe(text);
      // Line i here is line i of splitLines.
      for (const [i, line] of linesWithBreaks(text).entries())
        expect(line.replace(/\r\n|\r|\n/, "")).toBe(splitLines(text)[i] ?? "");
    });
});

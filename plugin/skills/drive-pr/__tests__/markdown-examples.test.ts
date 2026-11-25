import { describe, expect, it } from "bun:test";
import {
  parseBodyFindings,
  parseDeclaredUnanchored,
} from "../scripts/summary-findings.ts";

const LIVE_FINDING = [{ path: "live.ts", line: 3, text: "a live finding" }];

describe("withoutFencedExamples (summary Markdown examples)", () => {
  it.each([
    [
      "fenced examples and nested shorter fences",
      [
        "`not a fence ``` and still prose`",
        "```markdown",
        "- `example.ts:1` — a fenced decoy",
        "~~~",
        "- `still-example.ts:2` — a nested shorter fence",
        "```",
        "- `live.ts:3` — a live finding",
        "> 9 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      9,
    ],
    [
      "indented code examples with CRLF",
      [
        "    ```markdown",
        "    - `example.ts:1` — an indented code example",
        "    > 0 finding(s) without a diff-anchorable line",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\r\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "list-contained fence closed with container indentation",
      [
        "- explanation:",
        "  ```markdown",
        "  - `example.ts:1` — a fenced decoy",
        "    ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "top-level fence indented within three columns",
      [
        "  ```markdown",
        "  - `example.ts:1` — a fenced decoy",
        "```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "over-indented closer inside top-level fence",
      [
        "```markdown",
        "    ```",
        "    > 0 finding(s) without a diff-anchorable line",
        "```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "list marker and blank line inside list-contained fence",
      [
        "- explanation:",
        "  ```markdown",
        "",
        "  - ```",
        "  > 0 finding(s) without a diff-anchorable line",
        "  ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "prose mention and indented code delimiter",
      [
        "The example says 0 finding(s) without a diff-anchorable line.",
        "",
        "    ```",
        "    > 0 finding(s) without a diff-anchorable line",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "ordered-list fence and quoted fenced example",
      [
        "10. explanation:",
        "    ```markdown",
        "    > 0 finding(s) without a diff-anchorable line",
        "    ```",
        "> ```markdown",
        "> - `quoted.ts:1` — a fenced decoy",
        "> > 0 finding(s) without a diff-anchorable line",
        "> ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "quoted fence containing a literal `>` line",
      [
        "> ```markdown",
        "> >",
        "> > 0 finding(s) without a diff-anchorable line",
        "> ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "quoted fence delimiter with five spaces after `>` stays literal",
      [
        "> ```markdown",
        ">     ```",
        "> 0 finding(s) without a diff-anchorable line",
        "> ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "quoted fence indented at column four inside a list item",
      [
        "- explanation:",
        "    > ```markdown",
        "    > 0 finding(s) without a diff-anchorable line",
        "    > ```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "unclosed fence in a quoted list ends at the enclosing quote margin",
      [
        "> - explanation:",
        ">   ```markdown",
        ">   decoy",
        "> 1 finding(s) without a diff-anchorable line",
        "- `live.ts:3` — a live finding",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "quoted list does not leak into a document-level indented fence",
      [
        "> - quoted list item",
        "  ```markdown",
        "- `example.ts:1` — a fenced decoy",
        "```",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "same-line fence after a list marker scopes to the full marker width",
      [
        "- ```markdown",
        "  decoy",
        " > 1 finding(s) without a diff-anchorable line",
        "- `live.ts:3` — a live finding",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "HTML-commented examples",
      [
        "<!--",
        "- `quoted.ts:1` — a hidden finding",
        "> 0 finding(s) without a diff-anchorable line",
        "-->",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "unclosed comment opener inside fence and trailing single-line comments",
      [
        "```markdown",
        "<!-- unclosed literal opener in code",
        "```",
        "- `live.ts:3` — a live finding <!-- explanation -->",
        "> 1 finding(s) without a diff-anchorable line <!-- explanation -->",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "double-backtick inline code span quoting `<!--` does not open a comment",
      [
        "- `live.ts:3` — quoting `` `<!--` `` literally",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      [{ path: "live.ts", line: 3, text: "quoting `` `<!--` `` literally" }],
      1,
    ],
    [
      "closed comment followed by a multiline comment on the same line",
      [
        "<!-- first --> <!-- second",
        "> 0 finding(s) without a diff-anchorable line",
        "-->",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "visible finding followed by a trailing multiline comment",
      [
        "- `live.ts:3` — a live finding <!-- trailing",
        "> 0 finding(s) without a diff-anchorable line",
        "-->",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
    [
      "unclosed list and quote fences end at their containers",
      [
        "- explanation:",
        "  ```markdown",
        "  example",
        "- `list-live.ts:3` — a live finding",
        "> ```markdown",
        "> example",
        "- `quote-live.ts:4` — a live finding",
        "> 2 finding(s) without a diff-anchorable line",
      ].join("\n"),
      [
        { path: "list-live.ts", line: 3, text: "a live finding" },
        { path: "quote-live.ts", line: 4, text: "a live finding" },
      ],
      2,
    ],
    [
      "list ancestors survive when a child item closes",
      [
        "- parent:",
        "  - child:",
        "    text",
        "  ```markdown",
        "  example",
        "- `live.ts:3` — a live finding",
        "> 1 finding(s) without a diff-anchorable line",
      ].join("\n"),
      LIVE_FINDING,
      1,
    ],
  ])("handles %s", (_label, body, expectedFindings, expectedDeclared) => {
    expect(parseBodyFindings(body)).toEqual(expectedFindings);
    expect(parseDeclaredUnanchored(body)).toBe(expectedDeclared);
  });

  it("keeps paragraph continuations and ignores mixed-whitespace code blocks", () => {
    const body = [
      " \t> 0 finding(s) without a diff-anchorable line",
      "",
      "paragraph",
      "    > 1 finding(s) without a diff-anchorable line",
    ].join("\n");
    expect(parseDeclaredUnanchored(body)).toBe(1);
  });
});

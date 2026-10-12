/**
 * intent-chain.test.ts — the Refocus snapshot writer (plan W1
 * step 1): section extraction from Linear markdown, the calibration arm, and
 * the budget. The four oversized fixtures are the ones the plan's § W1
 * Acceptance names; each asserts a guarantee a simpler implementation (a
 * pooled reservation, a mid-line cut, an uncapped first line) would break.
 */

import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARM_LINE_PREFIX,
  BUDGET,
  capWithMarker,
  countCommentOpeners,
  extractIntent,
  extractScope,
  extractSection,
  type IntentChainInput,
  isIntentChainInput,
  LINE_CAP,
  listItems,
  main,
  normalizeMarkdown,
  PROTECTED_FLOOR,
  postEscapeBodyLen,
  refocusArm,
  renderIntentChain,
  TRUNCATION_MARKER,
} from "../scripts/intent-chain.ts";

/** The escape both consumers apply — strip the arm line, then expand every
 * literal `<!--` to `&lt;!--` — reproduced here so a test can assert on what
 * the consumer actually sees, not just on `postEscapeBodyLen`'s count. */
function consumerEscape(text: string): string {
  const nl = text.indexOf("\n");
  const body = nl === -1 ? "" : text.slice(nl + 1);
  return body.replaceAll("<!--", "&lt;!--");
}

const clen = (s: string) => Array.from(s).length;

/** Deterministic filler that never repeats a prefix, so "retained ≥ N chars of X" is checkable. */
function filler(tag: string, n: number): string {
  let s = "";
  for (let i = 0; clen(s) < n; i++) s += `${tag}${i} `;
  return `${Array.from(s)
    .slice(0, n - 1)
    .join("")}.`;
}

/** The body of `## <heading…>` in a rendered snapshot, without the heading. */
function renderedSection(text: string, headingPrefix: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${headingPrefix}`));
  if (start < 0) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i]!.startsWith("## "); i++)
    body.push(lines[i]!);
  return body.join("\n").trim();
}

const bulletLines = (section: string) =>
  section
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));

function issueMd(opts: {
  included?: string;
  excluded?: string[];
  acceptance?: string;
}): string {
  return [
    "## Problem",
    "",
    "Something is wrong.",
    "",
    "## Scope",
    "",
    "**Included**",
    "",
    opts.included ?? "Build the thing.",
    "",
    "**Excluded**",
    "",
    ...(opts.excluded ?? ["Anything else."]).map((l) => `* ${l}`),
    "",
    "## Acceptance criteria",
    "",
    opts.acceptance ?? "- [ ] It works.",
  ].join("\n");
}

const EPIC: IntentChainInput["epic"] = {
  identifier: "ENG-100",
  title: "The epic",
  updatedAt: "2026-09-27T00:00:00.000Z",
  description: [
    "## Execution Plan",
    "",
    "**Intent:** Ship W1 before W5 so the continuation line has a chain to point at.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] Every workstream is done.",
  ].join("\n"),
};

describe("normalizeMarkdown", () => {
  it("unwraps Linear mention tags and drops link targets", () => {
    const md =
      'see <issue id="x" href="https://linear.app/i/ENG-1">ENG-1</issue> and [the plan](<https://x/y#z>) and [ADR](https://a/b)';
    expect(normalizeMarkdown(md)).toBe("see ENG-1 and the plan and ADR");
  });
});

describe("extraction", () => {
  it("reads the epic Intent line", () => {
    expect(extractIntent(EPIC?.description ?? "")).toBe(
      "Ship W1 before W5 so the continuation line has a chain to point at.",
    );
    expect(extractIntent("no intent here")).toBe("");
  });

  it("reads acceptance criteria under a heading or under the template bold label", () => {
    expect(
      extractSection("## Acceptance criteria\n\n- [ ] a\n\n## Next\nx", [
        "acceptance criteria",
      ]),
    ).toBe("- [ ] a");
    const template =
      "## Requirements\n\n**Acceptance Criteria:**\n- [ ] one\n- [ ] two\n\n---\n\n## Strategy";
    expect(extractSection(template, ["acceptance criteria"])).toBe(
      "- [ ] one\n- [ ] two",
    );
  });

  it("splits a structured Scope section into included text and excluded lines", () => {
    const md = issueMd({
      included: "1. Writer\n   * nested detail",
      excluded: ["No network.", "No rule."],
    });
    const scope = extractScope(md);
    expect(scope.included).toBe("1. Writer\n   * nested detail");
    expect(scope.excluded).toEqual(["No network.", "No rule."]);
  });

  it("treats an unlabelled Scope section as all included, and finds a standalone Out of scope section", () => {
    const md =
      "## Scope\n\nJust this.\n\n## Out of scope\n\n- Not that.\n- Nor this,\n  wrapped.";
    expect(extractScope(md)).toEqual({
      included: "Just this.",
      excluded: ["Not that.", "Nor this, wrapped."],
    });
  });

  // The template is the producer this extractor exists for; reading it here
  // means a template edit that renames or restructures the section fails this
  // test instead of silently leaving new issues boundary-less. Skills also ship
  // standalone, without `.claude/commands/`, so there the test reports as
  // skipped — visibly, not as a pass.
  const TEMPLATE = join(import.meta.dir, "../../../commands/linear-issue.md");
  it.skipIf(!existsSync(TEMPLATE))(
    "extracts the Scope and acceptance sections from the live /linear-issue Phase 3 template",
    () => {
      const cmd = readFileSync(TEMPLATE, "utf8");
      const phase3 = cmd.slice(
        cmd.indexOf("### Phase 3: Generate Issue Description"),
      );
      const template = /```markdown\n([\s\S]*?)\n```/.exec(phase3)?.[1] ?? "";
      expect(template).toContain("## Scope");
      const scope = extractScope(template);
      expect(scope.included).toContain("What this issue delivers");
      expect(scope.excluded).toHaveLength(2);
      expect(scope.excluded[0]).toContain("One bullet per boundary");
      expect(extractSection(template, ["acceptance criteria"])).toContain(
        "[ ] [Criterion 1",
      );
    },
  );

  it("keeps a later Out of scope section alongside the Scope section’s Excluded block", () => {
    const md =
      "## Scope\n\n**Included**\n\n- a\n\n**Excluded**\n\n- b\n\n## Out of scope\n\n- c\n- b\n\n## Non-goals\n\n- d\n";
    expect(extractScope(md).excluded).toEqual(["b", "c", "d"]);
  });

  it("keeps a nested heading or bold label that also matches an excluded label as its own boundary", () => {
    // `### Non-goals` nests inside `## Out of scope` — both are excluded
    // labels. The extractor used to keep scanning past a nested heading
    // unless it closed the enclosing level, so `### Non-goals` was folded as
    // literal text into whatever bullet preceded it (`listItems` has no
    // heading syntax) and never visited as its own match, silently losing
    // "b" as a distinct boundary.
    const headingMd = "## Out of scope\n\n- a\n\n### Non-goals\n\n- b\n";
    expect(extractScope(headingMd).excluded).toEqual(["a", "b"]);

    // Same root cause for a nested bold label instead of a nested heading.
    const boldMd = "## Out of scope\n\n- a\n\n**Excluded**\n\n- b\n";
    expect(extractScope(boldMd).excluded).toEqual(["a", "b"]);
  });

  it("recognizes an ATX heading indented by 1-3 spaces (CommonMark-legal), not just column zero", () => {
    // `HEADING_RE` anchored at column zero, so a legally-indented
    // `## Acceptance Criteria` was invisible to it and got absorbed as body
    // text of whatever section/bold-label preceded it instead of ending it.
    // Markdown allows 1–3 leading spaces; anchoring every pattern at column
    // zero drops whole rows from the comparison.
    const md =
      "**Excluded**\n\n- Nothing adjacent.\n\n ## Acceptance Criteria\n\n- [ ] Works.";
    expect(extractSection(md, ["excluded"])).toBe("- Nothing adjacent.");
    expect(extractSection(md, ["acceptance criteria"])).toBe("- [ ] Works.");
  });

  it("folds nested bullets into their parent item", () => {
    expect(listItems("- a\n  - a.1\n- b")).toEqual(["a a.1", "b"]);
  });

  // Nesting follows CommonMark's content-column rule — a bullet is
  // folded into the current item only when its marker sits at or past that
  // item's content column (marker column + marker width + gap); a marker
  // before it is a sibling. A legally-indented (1-3 space) top-level list
  // therefore reads as flat siblings while the 2-space nested case above
  // still folds, from the same one rule.
  it("reads a 1-3 space indented top-level list as flat siblings, not folded continuations", () => {
    expect(listItems(" - a\n - b\n - c")).toEqual(["a", "b", "c"]);
    expect(listItems("  - a\n  - b")).toEqual(["a", "b"]);
    expect(listItems("   - a\n   - b")).toEqual(["a", "b"]);
  });

  it("still folds a bullet at or past the current item’s content column", () => {
    expect(listItems("  - a\n    - a.1\n  - b")).toEqual(["a a.1", "b"]);
    // Ordered marker: `1. ` is 3 columns wide, so content starts at column 3.
    expect(listItems("1. a\n   - a.1\n2. b")).toEqual(["a a.1", "b"]);
  });

  it("treats a marker before the current item’s content column as a sibling, even when it is indented more than the first marker", () => {
    // ` - a` has content column 3; `  - b` sits at column 2 — before it — so
    // it is a sibling, not a continuation.
    expect(listItems(" - a\n  - b")).toEqual(["a", "b"]);
    // The mirror shape: a later marker indented LESS than the first.
    expect(listItems("  - a\n - b")).toEqual(["a", "b"]);
    // Mixed legal indentation still folds a real nested child, and closes it.
    expect(listItems(" - a\n    - a.1\n  - b")).toEqual(["a a.1", "b"]);
  });

  it("treats a marker indented BELOW the first marker as closing the current list and starting a new one", () => {
    expect(listItems("  - a\n- b")).toEqual(["a", "b"]);
  });

  it("starts a new item after a blank line unless what follows is inside the current item", () => {
    // Indented less than the item's content column: a new item.
    expect(listItems(" - a\n\n- b")).toEqual(["a", "b"]);
    expect(listItems("- a\n\n b")).toEqual(["a", "b"]);
    expect(listItems("- a\n\nprose")).toEqual(["a", "prose"]);
  });

  it("keeps nested content together across a single blank line (a loose list), as CommonMark does", () => {
    // `- a\n\n  - b`: the child is still inside a's content column, so the
    // blank line does not end the item.
    expect(listItems("- a\n\n  - b")).toEqual(["a b"]);
    expect(listItems("- a\n\n  - b\n\n- c")).toEqual(["a b", "c"]);
    // A paragraph continuation indented to the content column stays too.
    expect(listItems("- a\n\n  more of a\n- b")).toEqual(["a more of a", "b"]);
    // Ordered marker: content column 3.
    expect(listItems("1. a\n\n   - a.1\n2. b")).toEqual(["a a.1", "b"]);
  });

  it("does not read four or more columns of indentation as a bullet marker that starts an item", () => {
    // Indented code, not a list item: kept whole as text — marker included,
    // never dropped from the population — rather than recognized as a marker
    // and emitted as an out-of-scope bullet.
    expect(listItems("    - example command")).toEqual(["- example command"]);
    // A tab is a 4-column stop, so a leading tab is the same indented code.
    expect(listItems("\t- tabbed")).toEqual(["- tabbed"]);
    // Inside an item whose content column it reaches (here 2), four columns
    // is a nested list, not indented code — with or without a blank line.
    expect(listItems("- a\n    - code\n- b")).toEqual(["a code", "b"]);
    expect(listItems("- a\n\n    - code\n- b")).toEqual(["a code", "b"]);
  });

  it("still recognizes a marker at the 3-column ceiling, and one behind a prose paragraph", () => {
    expect(listItems("   - a")).toEqual(["a"]);
    expect(listItems("Some prose.\n- a\n- b")).toEqual([
      "Some prose.",
      "a",
      "b",
    ]);
    // 4-space "bullet" cannot interrupt a paragraph (CommonMark): continuation.
    expect(listItems("Some prose.\n    - not a bullet")).toEqual([
      "Some prose. - not a bullet",
    ]);
  });
});

describe("refocusArm", () => {
  it("buckets by issue-number parity, odd on", () => {
    expect(refocusArm("ENG-8529", undefined)).toBe("on");
    expect(refocusArm("ENG-8530", undefined)).toBe("off");
  });
  it("honours JIG_REFOCUS in both directions", () => {
    expect(refocusArm("ENG-8530", "1")).toBe("on");
    expect(refocusArm("ENG-8529", "off")).toBe("off");
    expect(refocusArm("ENG-8530", "garbage")).toBe("off");
  });
});

describe("renderIntentChain — ordinary input", () => {
  it("renders every section, in priority order, with the arm line first", () => {
    const r = renderIntentChain(
      {
        epic: EPIC,
        issue: {
          identifier: "ENG-201",
          title: "Issue",
          updatedAt: "2026-09-28T01:00:00Z",
          description: issueMd({}),
        },
        subIssue: {
          identifier: "ENG-203",
          title: "Sub",
          description: issueMd({ included: "Sub work only." }),
        },
      },
      undefined,
    );
    expect(r.text.split("\n")[0]).toBe(`${ARM_LINE_PREFIX}on -->`);
    const order = [
      "Epic intent",
      "Epic acceptance",
      "Issue scope",
      "Issue acceptance",
      "Out of scope",
      "Sub-issue scope",
    ];
    const positions = order.map((h) => r.text.indexOf(`## ${h}`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(r.text).toContain("ENG-201 (issue, updated 2026-09-28T01:00:00Z)");
    expect(r.text).toContain("ENG-203 (sub-issue, updated unknown)");
    expect(r.truncated).toEqual([]);
  });

  it("renders the epic's own Included scope, not just its intent/acceptance criteria — the boundary is not lost when the selected child is passed as `issue` and the epic as `epic`", () => {
    const epicWithScope: IntentChainInput["epic"] = {
      ...EPIC,
      description: `${EPIC?.description}\n\n## Scope\n\n**Included**\n\nEverything under the coherence umbrella.`,
    };
    const r = renderIntentChain(
      {
        epic: epicWithScope,
        issue: {
          identifier: "ENG-201",
          title: "Child",
          description: issueMd({}),
        },
      },
      undefined,
    );
    expect(renderedSection(r.text, "Epic scope")).toBe(
      "Everything under the coherence umbrella.",
    );
    // Priority order: epic scope sits between epic intent and epic acceptance.
    const [intentPos, scopePos, acceptancePos] = [
      "Epic intent",
      "Epic scope",
      "Epic acceptance",
    ].map((h) => r.text.indexOf(`## ${h}`));
    expect(intentPos).toBeLessThan(scopePos!);
    expect(scopePos).toBeLessThan(acceptancePos!);
  });

  it("omits the Epic scope section when the epic has no `## Scope` block, same as every other empty section", () => {
    const r = renderIntentChain(
      {
        epic: EPIC,
        issue: { identifier: "ENG-201", description: issueMd({}) },
      },
      undefined,
    );
    expect(r.text).not.toContain("## Epic scope");
  });

  it("renders the batch form: anchor intent plus one line per item", () => {
    const r = renderIntentChain(
      {
        mode: "batch",
        epic: EPIC,
        issue: {
          identifier: "ENG-300",
          title: "Anchor",
          description: issueMd({}),
        },
        items: [
          { identifier: "ENG-300", title: "Anchor" },
          { identifier: "ENG-301", title: "Second" },
        ],
      },
      undefined,
    );
    expect(renderedSection(r.text, "Batch items")).toBe(
      "- ENG-300 — Anchor\n- ENG-301 — Second",
    );
    expect(r.text).toContain("(batch anchor,");
  });

  it("dedupes an out-of-scope line restated at another level, keeping distinct ones from each", () => {
    const shared = "No network calls.";
    const epicWithBoundary: IntentChainInput["epic"] = {
      ...EPIC,
      description: `${EPIC?.description}\n\n## Out of scope\n\n- ${shared}`,
    };
    const r = renderIntentChain(
      {
        epic: epicWithBoundary,
        issue: {
          identifier: "ENG-201",
          title: "Issue",
          description: issueMd({ excluded: [shared, "Issue-only boundary."] }),
        },
        subIssue: {
          identifier: "ENG-203",
          title: "Sub",
          description: issueMd({ excluded: [shared, "Sub-only boundary."] }),
        },
      },
      undefined,
    );
    expect(bulletLines(renderedSection(r.text, "Out of scope"))).toEqual([
      shared,
      "Issue-only boundary.",
      "Sub-only boundary.",
    ]);
  });

  it("caps an absurdly long identifier/updatedAt so the header cannot erase the protected sections", () => {
    const oos = ["A real boundary that must survive."];
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          identifier: filler("E", 5000),
          updatedAt: filler("T", 5000),
        },
        issue: {
          identifier: "ENG-201",
          updatedAt: filler("T", 5000),
          description: issueMd({ excluded: oos }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    // The oversized fields were genuinely truncated, not coincidentally
    // short already.
    expect(r.text).toContain(TRUNCATION_MARKER);
    expect(r.text).not.toContain(filler("E", 5000));
    // The boundary above still renders in full — before this cap, the header
    // alone would have exceeded BUDGET and the final prefix-slice would have
    // dropped every section including this one.
    expect(bulletLines(renderedSection(r.text, "Out of scope"))).toEqual(oos);
  });

  it("caps an absurdly long issue/sub-issue identifier in section HEADINGS too, not just the source lines", () => {
    // `isChainIssue` bounds an identifier's format, never its length, and
    // unlike `sourceLine`'s fields a section `heading` is never touched by
    // the truncation loop (which only shrinks `.text`/`.lines`). An oversized
    // `issue`/`subIssue` identifier embedded straight into "Issue scope (…)",
    // "Issue acceptance criteria (…)" or "Sub-issue scope (…)" used to make
    // the header-plus-headings alone exceed BUDGET before the loop ever ran,
    // so the final prefix-slice backstop fired for real and dropped every
    // section after it — including this protected boundary.
    const oos = ["A real boundary that must survive."];
    const r = renderIntentChain(
      {
        issue: {
          identifier: filler("I", 5000),
          description: issueMd({ excluded: oos }),
        },
        subIssue: { identifier: filler("S", 5000), title: "Sub" },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    expect(r.text).toContain(TRUNCATION_MARKER);
    expect(r.text).not.toContain(filler("I", 5000));
    expect(r.text).not.toContain(filler("S", 5000));
    expect(bulletLines(renderedSection(r.text, "Out of scope"))).toEqual(oos);
  });
});

describe("renderIntentChain — the four oversized fixtures (plan § W1 Acceptance)", () => {
  it("1: all three protected sections oversized at once each keep their own floor", () => {
    // Protected sections of 3000 / ~3000 / 3000 characters: under a pooled
    // 450-character reservation one of them could take the whole pool.
    const oos = Array.from({ length: 50 }, (_, i) => filler(`o${i}x`, 60));
    const issueScope = filler("S", 3000);
    const subScope = filler("U", 3000);
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          identifier: "ENG-100",
          description: `**Intent:** ${filler("I", 2000)}\n\n## Acceptance criteria\n\n${filler("E", 3000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: issueScope,
            excluded: oos,
            acceptance: filler("A", 3000),
          }),
        },
        subIssue: {
          identifier: "ENG-203",
          description: issueMd({ included: subScope, excluded: [] }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);

    const keptIssue = renderedSection(r.text, "Issue scope").replace(
      TRUNCATION_MARKER,
      "",
    );
    const keptSub = renderedSection(r.text, "Sub-issue scope").replace(
      TRUNCATION_MARKER,
      "",
    );
    expect(clen(keptIssue)).toBeGreaterThanOrEqual(PROTECTED_FLOOR);
    expect(issueScope.startsWith(keptIssue.trimEnd())).toBe(true);
    expect(clen(keptSub)).toBeGreaterThanOrEqual(PROTECTED_FLOOR);
    expect(subScope.startsWith(keptSub.trimEnd())).toBe(true);

    const keptOos = bulletLines(renderedSection(r.text, "Out of scope"));
    // Whole 60-char lines up to the 150 floor: exactly two.
    expect(keptOos).toEqual(oos.slice(0, 2));
    expect(r.truncated).toEqual(
      expect.arrayContaining([
        "sub-issue-scope",
        "out-of-scope",
        "issue-scope",
      ]),
    );
  });

  it("2: several short out-of-scope lines share the floor by whole line, never cut mid-line", () => {
    const oos = [
      "Alpha boundary line.",
      "Beta boundary line here.",
      "Gamma line.",
      "Delta boundary line text.",
      ...Array.from({ length: 40 }, (_, i) => `Extra boundary ${i}.`),
    ];
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `## Acceptance criteria\n\n${filler("E", 5000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: "short",
            excluded: oos,
            acceptance: filler("A", 5000),
          }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    const kept = bulletLines(renderedSection(r.text, "Out of scope"));
    expect(kept.length).toBeGreaterThan(0);
    for (const l of kept) expect(oos).toContain(l);
    expect(kept).toEqual(oos.slice(0, kept.length));
    expect(kept.length).toBeLessThan(oos.length);
  });

  it("3: a first line over its floor but under the cap is kept in full", () => {
    const first = filler("F", 400);
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `## Acceptance criteria\n\n${filler("E", 5000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            excluded: [first, "second line"],
            acceptance: filler("A", 5000),
          }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    expect(bulletLines(renderedSection(r.text, "Out of scope"))).toEqual([
      first,
    ]);
  });

  it("4: a first line over the 1,000-character cap is marker-truncated at exactly the cap", () => {
    const first = filler("G", 2500);
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `**Intent:** ${filler("I", 3000)}\n\n## Acceptance criteria\n\n${filler("E", 5000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: filler("S", 3000),
            excluded: [first],
            acceptance: filler("A", 5000),
          }),
        },
        subIssue: {
          identifier: "ENG-203",
          description: issueMd({ included: filler("U", 3000), excluded: [] }),
        },
      },
      undefined,
    );
    const kept = bulletLines(renderedSection(r.text, "Out of scope"))[0]!;
    expect(clen(kept)).toBe(LINE_CAP);
    expect(kept.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(
      first.startsWith(kept.slice(0, -TRUNCATION_MARKER.length).trimEnd()),
    ).toBe(true);
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
  });
});

describe("countCommentOpeners / postEscapeBodyLen", () => {
  it("counts non-overlapping `<!--` occurrences", () => {
    expect(countCommentOpeners("no openers here")).toBe(0);
    expect(countCommentOpeners("<!-- one -->")).toBe(1);
    expect(countCommentOpeners("<!--<!--<!--")).toBe(3);
  });

  it("adds 3 characters per opener, on the body only (arm line excluded)", () => {
    const text = `${ARM_LINE_PREFIX}on -->\n<!--a<!--b`;
    // Body is "<!--a<!--b" (10 chars, 2 openers) → 10 + 2*3 = 16.
    expect(postEscapeBodyLen(text)).toBe(16);
  });
});

describe("renderIntentChain — escaping headroom", () => {
  it("a near-budget snapshot whose unprotected sections carry many literal <!-- sequences still fits post-escape, and protected sections survive both the writer AND the consumer escape+cap", () => {
    // The epic acceptance criteria section is unprotected (lowest priority
    // band) and, ordinarily, adversarial or just Linear-markdown-heavy text
    // — squarely inside ADR-0079's threat model, not a contrived-only input.
    const openers = "<!-- ".repeat(400); // 400 openers, 2000 raw chars.
    const oos = ["A hard boundary line.", "A second boundary line."];
    const subScope = filler("U", 500);
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `## Acceptance criteria\n\n${openers}${filler("E", 3000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: filler("S", 500),
            excluded: oos,
            acceptance: filler("A", 3000),
          }),
        },
        subIssue: {
          identifier: "ENG-203",
          description: issueMd({ included: subScope, excluded: [] }),
        },
      },
      undefined,
    );
    // The writer's own raw-length guarantee still holds.
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    // The NEW guarantee: the length either consumer's escape step
    // actually produces also fits BUDGET, so their prefix-slice cap never
    // has to fire and cut into a protected section.
    expect(postEscapeBodyLen(r.text)).toBeLessThanOrEqual(BUDGET);

    // Reproduce the consumer's own transform end to end and confirm the
    // protected sections still meet their floor through it — the escaping
    // load in the unprotected epic-acceptance section tightens the overall
    // budget, so the protected sections legitimately shrink toward their
    // floor rather than staying untouched, but never below it or mid-line.
    const escaped = consumerEscape(r.text);
    expect(Array.from(escaped).length).toBeLessThanOrEqual(BUDGET);
    expect(escaped).toContain(oos[0]!);
    const keptSub = renderedSection(escaped, "Sub-issue scope").replace(
      TRUNCATION_MARKER,
      "",
    );
    expect(clen(keptSub)).toBeGreaterThanOrEqual(PROTECTED_FLOOR);
    expect(subScope.startsWith(keptSub.trimEnd())).toBe(true);
  });

  it("with the openers in a PROTECTED section instead, the writer still keeps the post-escape length within budget", () => {
    // Same shape, but this time the escaping load sits inside the protected
    // out-of-scope section itself — the writer must count its OWN openers
    // toward its own floor decision too, not just an unprotected section's.
    const oos = [`${"<!-- ".repeat(100)}boundary.`, "A second boundary."];
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `## Acceptance criteria\n\n${filler("E", 3600)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: filler("S", 300),
            excluded: oos,
            acceptance: filler("A", 3000),
          }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    expect(postEscapeBodyLen(r.text)).toBeLessThanOrEqual(BUDGET);
    const escaped = consumerEscape(r.text);
    expect(Array.from(escaped).length).toBeLessThanOrEqual(BUDGET);
  });
});

describe("capWithMarker", () => {
  it("leaves short strings alone and caps long ones at exactly max, even when the cut lands on a space", () => {
    expect(capWithMarker("abc", 10)).toBe("abc");
    expect(clen(capWithMarker(filler("x", 50), 20))).toBe(20);
    // 'x0 x1 x2 x3 …' — keep = 20 - 13 = 7 lands right after "x0 x1 x" /
    // before a space in other offsets; try every offset.
    for (let max = 14; max < 40; max++) {
      expect(clen(capWithMarker(filler("x", 60), max))).toBe(max);
    }
  });
});

describe("renderIntentChain — floor never grows a section", () => {
  it("leaves a protected section just over the floor untouched rather than padding it with the marker", () => {
    const scope = filler("S", PROTECTED_FLOOR + 5);
    const r = renderIntentChain(
      {
        epic: {
          ...EPIC,
          description: `## Acceptance criteria\n\n${filler("E", 3000)}`,
        },
        issue: {
          identifier: "ENG-201",
          description: issueMd({
            included: filler("Q", 400),
            acceptance: filler("A", 3000),
          }),
        },
        subIssue: {
          identifier: "ENG-203",
          description: issueMd({ included: scope, excluded: [] }),
        },
      },
      undefined,
    );
    expect(clen(r.text)).toBeLessThanOrEqual(BUDGET);
    expect(renderedSection(r.text, "Sub-issue scope")).toBe(scope);
  });
});

describe("isIntentChainInput", () => {
  it("rejects a missing issue, a non-Linear identifier, and a batch without items", () => {
    expect(isIntentChainInput({})).toBe(false);
    expect(
      isIntentChainInput({ issue: { identifier: "ENG-1; rm -rf /" } }),
    ).toBe(false);
    expect(
      isIntentChainInput({ mode: "batch", issue: { identifier: "ENG-1" } }),
    ).toBe(false);
    expect(
      isIntentChainInput({ issue: { identifier: "ENG-1" }, epic: null }),
    ).toBe(true);
    // The identifier grammar `handoff.ts`'s branch parser and the consumer's
    // `refocus.sh` hook restate (a skill cannot import a sibling): a digit after the first
    // letter is valid, a leading digit is not.
    expect(isIntentChainInput({ issue: { identifier: "DOC2-123" } })).toBe(
      true,
    );
    expect(isIntentChainInput({ issue: { identifier: "1ENG-5" } })).toBe(false);
  });

  it("rejects a batch with an empty items array, not just an absent one", () => {
    // `[].every(isChainIssue)` is vacuously true, so the array-shape check
    // alone would pass this — the emptiness must be checked explicitly.
    expect(
      isIntentChainInput({
        mode: "batch",
        issue: { identifier: "ENG-1" },
        items: [],
      }),
    ).toBe(false);
    expect(
      isIntentChainInput({
        mode: "batch",
        issue: { identifier: "ENG-1" },
        items: [{ identifier: "ENG-1" }],
      }),
    ).toBe(true);
  });
});

describe("main", () => {
  it("writes the snapshot and prints a JSON summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-chain-"));
    try {
      const inPath = join(dir, "in.json");
      const outPath = join(dir, "nested", "intent-chain.md");
      writeFileSync(
        inPath,
        JSON.stringify({
          issue: { identifier: "ENG-8530", description: issueMd({}) },
        }),
      );
      const logs: string[] = [];
      const orig = console.log;
      console.log = (s: string) => logs.push(s);
      try {
        expect(main(["--input", inPath, "--out", outPath])).toBe(0);
      } finally {
        console.log = orig;
      }
      const summary = JSON.parse(logs[0]!);
      expect(summary.path).toBe(outPath);
      expect(summary.sessionPath).toBeNull();
      expect(summary.arm).toBe("off");
      expect(readFileSync(outPath, "utf8")).toContain(
        "## Issue scope (ENG-8530)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 on invalid input and 2 on a usage error", () => {
    const dir = mkdtempSync(join(tmpdir(), "intent-chain-"));
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => errs.push(s);
    try {
      const inPath = join(dir, "bad.json");
      writeFileSync(inPath, '{"issue":{}}');
      expect(main(["--input", inPath, "--out", join(dir, "o.md")])).toBe(1);
      expect(main(["stray"])).toBe(2);
    } finally {
      console.error = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Every other test above passes `--out`, which deliberately skips the
  // default-path/pointer-writing code (see main()'s `outOverride` branch) —
  // so none of them could catch the writer reading a session-id env var
  // ($CLAUDE_SESSION_ID) Claude Code never actually sets. This test runs the
  // CLI the way `/do-item` really invokes it — no `--out`, in a real git
  // repo, with $CLAUDE_CODE_SESSION_ID set — and checks every file the
  // consumer's Refocus hook reads from. The hook itself stays in the
  // consumer repository, so its side of the path is tested there.
  it("without --out, in a real repo, writes the primary snapshot, the .current pointer and an identical session copy", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-e2e-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (
          v !== undefined &&
          !k.startsWith("GIT_") &&
          k !== "CLAUDE_CODE_SESSION_ID" &&
          k !== "CODEX_THREAD_ID"
        )
          env[k] = v;
      }
      expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(
        0,
      );
      const scriptPath = join(import.meta.dir, "../scripts/intent-chain.ts");
      const input = JSON.stringify({
        issue: { identifier: "ENG-9001", description: issueMd({}) },
      });
      const writerEnv = { ...env, CLAUDE_CODE_SESSION_ID: "e2e-session-1" };
      const writer = Bun.spawnSync(["bun", scriptPath], {
        cwd: repo,
        env: writerEnv,
        stdin: Buffer.from(input),
      });
      expect(writer.exitCode).toBe(0);
      const summary = JSON.parse(writer.stdout.toString());
      // realpathSync: `git rev-parse --show-toplevel` resolves symlinks
      // (macOS's /var → /private/var), while mkdtempSync's return value does
      // not — the same normalization the sibling handoff.ts test applies.
      const realRepo = realpathSync(repo);
      expect(summary.path).toBe(
        join(realRepo, ".context", "intent-chain", "ENG-9001.md"),
      );
      expect(
        readFileSync(
          join(realRepo, ".context", "intent-chain", ".current"),
          "utf8",
        ),
      ).toBe("ENG-9001");
      expect(
        readFileSync(
          join(
            realRepo,
            ".context",
            "refocus-state",
            "e2e-session-1.intent-chain.md",
          ),
          "utf8",
        ),
      ).toBe(readFileSync(summary.path, "utf8"));
      expect(summary.sessionPath).toBe(
        join(
          realRepo,
          ".context",
          "refocus-state",
          "e2e-session-1.intent-chain.md",
        ),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Runs the writer the way `/do-item` does (no `--out`) in a scratch git
  // repo, as a subprocess: `repoRoot()` reads git from the process's own cwd.
  function runWriter(
    repo: string,
    input: unknown,
    extraEnv: Record<string, string> = {},
    args: string[] = [],
  ) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (
        v !== undefined &&
        !k.startsWith("GIT_") &&
        k !== "CLAUDE_CODE_SESSION_ID" &&
        k !== "CODEX_THREAD_ID"
      )
        env[k] = v;
    }
    Object.assign(env, extraEnv);
    expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(
      0,
    );
    return Bun.spawnSync(
      ["bun", join(import.meta.dir, "../scripts/intent-chain.ts"), ...args],
      { cwd: repo, env, stdin: Buffer.from(JSON.stringify(input)) },
    );
  }

  it("preserves session copies through alias overwrites and changes only on that session pickup", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-session-isolation-"));
    try {
      // The session copy is the file the consumer's Refocus hook reads.
      const sessionCopy = () =>
        readFileSync(
          join(
            realpathSync(repo),
            ".context",
            "refocus-state",
            "batch-session.intent-chain.md",
          ),
          "utf8",
        );
      const batch = {
        mode: "batch",
        issue: { identifier: "ENG-9401", description: "Batch scope." },
        items: [{ identifier: "ENG-9401" }, { identifier: "ENG-9402" }],
        subIssue: {
          identifier: "ENG-9403",
          description: "## Scope\n\nSelected child scope.",
        },
      };
      const first = runWriter(repo, batch, {
        CODEX_THREAD_ID: "batch-session",
      });
      expect(first.exitCode, first.stderr.toString()).toBe(0);
      const original = sessionCopy();
      expect(original).toContain("Selected child scope.");
      const chainDir = join(realpathSync(repo), ".context", "intent-chain");
      for (const id of ["ENG-9401", "ENG-9402", "ENG-9403"]) {
        const solo = runWriter(
          repo,
          {
            issue: {
              identifier: id,
              description: `## Scope\n\nSolo ${id} scope.`,
            },
          },
          { CODEX_THREAD_ID: `solo-${id}` },
        );
        expect(solo.exitCode, solo.stderr.toString()).toBe(0);
        expect(readFileSync(join(chainDir, `${id}.md`), "utf8")).toContain(
          `Solo ${id} scope.`,
        );
        expect(sessionCopy()).toBe(original);
      }
      const next = runWriter(
        repo,
        {
          issue: {
            identifier: "ENG-9404",
            description: "## Scope\n\nNext explicit pickup.",
          },
        },
        { CODEX_THREAD_ID: "batch-session" },
      );
      expect(next.exitCode, next.stderr.toString()).toBe(0);
      expect(sessionCopy()).toContain("Next explicit pickup.");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports failed session copy writes without creating an identity pointer", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-session-failure-"));
    try {
      const stateDir = join(repo, ".context", "refocus-state");
      mkdirSync(join(stateDir, "blocked.intent-chain.md"), { recursive: true });
      const writer = runWriter(
        repo,
        { issue: { identifier: "ENG-9501" } },
        {
          CODEX_THREAD_ID: "blocked",
        },
      );
      expect(writer.exitCode, writer.stderr.toString()).toBe(1);
      expect(JSON.parse(writer.stdout.toString()).pointerErrors).toEqual([
        expect.stringContaining("session snapshot"),
      ]);
      expect(existsSync(join(stateDir, "blocked.current-item"))).toBe(false);
      expect(readdirSync(stateDir)).toEqual(["blocked.intent-chain.md"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("removes the previous session scope when an explicit replacement fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-session-stale-"));
    try {
      const first = runWriter(
        repo,
        { issue: { identifier: "ENG-9601", title: "Old scope." } },
        { CODEX_THREAD_ID: "same-session" },
      );
      expect(first.exitCode, first.stderr.toString()).toBe(0);
      const sessionPath = join(
        realpathSync(repo),
        ".context",
        "refocus-state",
        "same-session.intent-chain.md",
      );
      expect(readFileSync(sessionPath, "utf8")).toContain("Old scope.");
      // A directory at this child's exact tmp path makes only the session
      // replacement fail, while the existing old snapshot is still removable.
      const wrapper = `import { mkdirSync } from 'node:fs';
        import { main } from ${JSON.stringify(join(import.meta.dir, "../scripts/intent-chain.ts"))};
        mkdirSync(${JSON.stringify(sessionPath)} + '.tmp-' + process.pid);
        process.exit(main([]));`;
      const writer = Bun.spawnSync(["bun", "-e", wrapper], {
        cwd: repo,
        env: {
          ...process.env,
          CLAUDE_CODE_SESSION_ID: "",
          CODEX_THREAD_ID: "same-session",
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_INDEX_FILE: undefined,
        },
        stdin: Buffer.from(
          JSON.stringify({
            issue: { identifier: "ENG-9603", title: "New scope." },
          }),
        ),
      });
      expect(writer.exitCode, writer.stderr.toString()).toBe(1);
      expect(writer.stderr.toString()).toContain("session snapshot");
      expect(existsSync(sessionPath)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("removes the previous session scope when the primary snapshot or the input fails", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-session-early-"));
    try {
      const env = { CODEX_THREAD_ID: "early-session" };
      const first = runWriter(
        repo,
        { issue: { identifier: "ENG-9701", title: "Old scope." } },
        env,
      );
      expect(first.exitCode, first.stderr.toString()).toBe(0);
      const root = realpathSync(repo);
      const sessionPath = join(
        root,
        ".context",
        "refocus-state",
        "early-session.intent-chain.md",
      );
      expect(existsSync(sessionPath)).toBe(true);
      // A directory at the new pickup's primary path fails the primary write,
      // which returns before the session copy is ever replaced.
      mkdirSync(join(root, ".context", "intent-chain", "ENG-9702.md"));
      const blocked = runWriter(
        repo,
        { issue: { identifier: "ENG-9702", title: "New scope." } },
        env,
      );
      expect(blocked.exitCode, blocked.stderr.toString()).toBe(1);
      expect(blocked.stderr.toString()).toContain("cannot write");
      expect(existsSync(sessionPath)).toBe(false);

      // Invalid input is a failed pickup too.
      const again = runWriter(
        repo,
        { issue: { identifier: "ENG-9703", title: "Third scope." } },
        env,
      );
      expect(again.exitCode, again.stderr.toString()).toBe(0);
      expect(existsSync(sessionPath)).toBe(true);
      const invalid = runWriter(repo, { not: "an input" }, env);
      expect(invalid.exitCode, invalid.stderr.toString()).toBe(1);
      expect(existsSync(sessionPath)).toBe(false);

      // A malformed invocation (`--input` with no value) fails before any
      // parsing succeeds, and is a failed pickup too.
      const third = runWriter(
        repo,
        { issue: { identifier: "ENG-9704", title: "Fourth scope." } },
        env,
      );
      expect(third.exitCode, third.stderr.toString()).toBe(0);
      expect(existsSync(sessionPath)).toBe(true);
      const malformed = runWriter(repo, {}, env, ["--input"]);
      expect(malformed.exitCode, malformed.stderr.toString()).toBe(2);
      expect(existsSync(sessionPath)).toBe(false);

      // ...but a malformed invocation that names `--out` keeps the exemption.
      const fifth = runWriter(
        repo,
        { issue: { identifier: "ENG-9705", title: "Fifth scope." } },
        env,
      );
      expect(fifth.exitCode, fifth.stderr.toString()).toBe(0);
      const outMalformed = runWriter(repo, {}, env, ["--out", "--bogus"]);
      expect(outMalformed.exitCode, outMalformed.stderr.toString()).toBe(2);
      expect(existsSync(sessionPath)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("also writes the snapshot under every batch item and the selected sub-issue, so a branch named after either resolves it", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-alias-"));
    try {
      const writer = runWriter(repo, {
        mode: "batch",
        issue: { identifier: "ENG-8554", description: issueMd({}) },
        subIssue: { identifier: "ENG-8600", description: issueMd({}) },
        items: [
          { identifier: "ENG-8554", title: "anchor" },
          { identifier: "ENG-8558", title: "highest priority" },
        ],
      });
      expect(writer.exitCode).toBe(0);
      const chainDir = join(realpathSync(repo), ".context", "intent-chain");
      const anchorText = readFileSync(join(chainDir, "ENG-8554.md"), "utf8");
      for (const alias of ["ENG-8558", "ENG-8600"]) {
        expect(readFileSync(join(chainDir, `${alias}.md`), "utf8")).toBe(
          anchorText,
        );
      }
      // The pointer still names the anchor, and no alias claims it.
      expect(readFileSync(join(chainDir, ".current"), "utf8")).toBe("ENG-8554");
      expect(JSON.parse(writer.stdout.toString()).pointerErrors).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores `items` outside batch mode, so a malformed single-issue input cannot overwrite another item’s chain", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-nobatch-"));
    try {
      const writer = runWriter(repo, {
        issue: { identifier: "ENG-8600", description: issueMd({}) },
        items: [{ identifier: "ENG-8601", title: "not a batch" }],
      });
      expect(writer.exitCode).toBe(0);
      const chainDir = join(realpathSync(repo), ".context", "intent-chain");
      expect(existsSync(join(chainDir, "ENG-8600.md"))).toBe(true);
      expect(existsSync(join(chainDir, "ENG-8601.md"))).toBe(false);
      // An explicit `mode: 'issue'` is the same case, not just an absent mode.
      const explicit = runWriter(repo, {
        mode: "issue",
        issue: { identifier: "ENG-8602", description: issueMd({}) },
        items: [{ identifier: "ENG-8603", title: "not a batch either" }],
      });
      expect(explicit.exitCode).toBe(0);
      expect(existsSync(join(chainDir, "ENG-8603.md"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keys the session snapshot on CODEX_THREAD_ID under Codex, and prefers CLAUDE_CODE_SESSION_ID when both are set", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-codex-"));
    try {
      const stateDir = join(realpathSync(repo), ".context", "refocus-state");
      // Codex: no CLAUDE_* name at all, only its own thread id.
      const codex = runWriter(
        repo,
        { issue: { identifier: "ENG-9003", description: issueMd({}) } },
        { CODEX_THREAD_ID: "thread-abc/123" },
      );
      expect(codex.exitCode).toBe(0);
      // Sanitized exactly as the consumer's refocus.sh hook names the file it
      // will look up.
      expect(
        readFileSync(join(stateDir, "thread-abc_123.intent-chain.md"), "utf8"),
      ).toContain("ENG-9003");
      // Both set (a Codex session hosting a Claude subprocess, say): Claude's
      // own id wins, and no pointer is written under the thread id.
      const both = runWriter(
        repo,
        { issue: { identifier: "ENG-9004", description: issueMd({}) } },
        { CLAUDE_CODE_SESSION_ID: "claude-sess", CODEX_THREAD_ID: "thread-x" },
      );
      expect(both.exitCode).toBe(0);
      expect(
        readFileSync(join(stateDir, "claude-sess.intent-chain.md"), "utf8"),
      ).toContain("ENG-9004");
      expect(existsSync(join(stateDir, "thread-x.intent-chain.md"))).toBe(
        false,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The writer's 14-day prune covers session copies too. A live session
  // keeps its copy by refreshing its mtime on every read; that refresh is the
  // consumer's Refocus hook's job and is tested in the consumer repository.
  it("prunes an aged session snapshot on a later pickup, but spares a fresh one", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-retention-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("GIT_") && k !== "CODEX_THREAD_ID")
          env[k] = v;
      }
      env.CLAUDE_CODE_SESSION_ID = "retention-sess";
      expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(
        0,
      );
      const writer = (id: string) =>
        Bun.spawnSync(
          ["bun", join(import.meta.dir, "../scripts/intent-chain.ts")],
          {
            cwd: repo,
            env,
            stdin: Buffer.from(
              JSON.stringify({
                issue: { identifier: id, description: issueMd({}) },
              }),
            ),
          },
        );
      expect(writer("ENG-9101").exitCode).toBe(0);
      const stateDir = join(realpathSync(repo), ".context", "refocus-state");
      const used = join(stateDir, "retention-sess.intent-chain.md");
      const unused = join(stateDir, "unused-sess.intent-chain.md");
      writeFileSync(unused, readFileSync(used));
      const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      utimesSync(unused, old, old);

      // A later pickup for a different item writes — and prunes.
      expect(
        runWriter(
          repo,
          { issue: { identifier: "ENG-9102" } },
          { CLAUDE_CODE_SESSION_ID: "later-sess" },
        ).exitCode,
      ).toBe(0);
      expect(existsSync(used)).toBe(true);
      expect(existsSync(unused)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // A PR-scoped pin outlives the per-item window, or a pin idle for
  // longer than the 14-day item window would be deleted by the next unrelated
  // pickup's write and the round would fall back to the substitution it replaces.
  it("keeps a PR-scoped pin past the 14-day item window, and still bounds it", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-pin-retention-"));
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
      }
      expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(
        0,
      );
      const writer = (id: string) =>
        Bun.spawnSync(
          ["bun", join(import.meta.dir, "../scripts/intent-chain.ts")],
          {
            cwd: repo,
            env,
            stdin: Buffer.from(
              JSON.stringify({
                issue: { identifier: id, description: issueMd({}) },
              }),
            ),
          },
        );
      expect(writer("ENG-9301").exitCode).toBe(0);
      const chainDir = join(realpathSync(repo), ".context", "intent-chain");
      const daysAgo = (n: number) =>
        new Date(Date.now() - n * 24 * 60 * 60 * 1000);
      const pin20 = join(chainDir, "pr.42.md");
      const pin100 = join(chainDir, "pr.43.md");
      const item20 = join(chainDir, "ENG-9302.md");
      for (const f of [pin20, pin100, item20]) {
        writeFileSync(f, "<!-- refocus-arm: off -->\nx\n");
      }
      utimesSync(pin20, daysAgo(20), daysAgo(20));
      utimesSync(pin100, daysAgo(100), daysAgo(100));
      utimesSync(item20, daysAgo(20), daysAgo(20));

      // A later, unrelated pickup writes — and prunes.
      expect(writer("ENG-9303").exitCode).toBe(0);
      expect(existsSync(pin20)).toBe(true);
      expect(existsSync(pin100)).toBe(false);
      expect(existsSync(item20)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("exits 1, names the failure and lists it in pointerErrors when the content landed but a pointer write failed, leaving no tmp debris", () => {
    const repo = mkdtempSync(join(tmpdir(), "intent-chain-partial-"));
    try {
      // A directory where `.current` belongs makes the pointer's rename fail
      // while the content write before it succeeds.
      const chainDir = join(realpathSync(repo), ".context", "intent-chain");
      mkdirSync(join(chainDir, ".current"), { recursive: true });
      const writer = runWriter(repo, {
        issue: { identifier: "ENG-9002", description: issueMd({}) },
      });
      expect(writer.exitCode).toBe(1);
      const summary = JSON.parse(writer.stdout.toString());
      expect(summary.pointerErrors).toHaveLength(1);
      expect(summary.pointerErrors[0]).toContain(".current pointer");
      expect(writer.stderr.toString()).toContain(".current pointer");
      // The content itself did land — that is what makes it PARTIAL.
      expect(readFileSync(join(chainDir, "ENG-9002.md"), "utf8")).toContain(
        "## Issue scope (ENG-9002)",
      );
      expect(readdirSync(chainDir).filter((n) => n.includes(".tmp-"))).toEqual(
        [],
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

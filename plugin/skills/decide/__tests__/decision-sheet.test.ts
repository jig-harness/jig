/**
 * Suite for the decision sheet: one decision source rendered as an HTML sheet,
 * a full markdown elaboration and a short tracker comment.
 *
 * The two claim tests are the core. "Pilot parity" holds the renderer to every
 * claim of the stored pilot sheet. "No claim absent from the source" holds
 * every rendered word to either the source or the fixed label table, so a
 * projection can never assert something the decision record does not.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Element, Window } from "happy-dom";
import { gitIdentityEnv } from "../../drive-pr/scripts/lib/proc.ts";
import {
  sheetAttachmentTitle,
  staleSheetAttachments,
} from "../scripts/decision-sheet/attachments.ts";
import {
  checkFreshness,
  citedPaths,
} from "../scripts/decision-sheet/freshness.ts";
import { renderHtml } from "../scripts/decision-sheet/html.ts";
import { SIDE_BY_SIDE_MAX_CLAIMS } from "../scripts/decision-sheet/html-compact.ts";
import {
  extractSource,
  extractTemplate,
  OUTCOME_COLOUR,
  SHEET_TEMPLATES,
  type SheetTemplate,
} from "../scripts/decision-sheet/html-shared.ts";
import {
  COMMENT,
  DOCUMENT_LABEL,
  LABEL,
  OUTCOME_ICON,
  OUTCOME_WORD,
  SHEET_FILENAME_SUFFIX,
} from "../scripts/decision-sheet/labels.ts";
import {
  renderComment,
  renderElaboration,
} from "../scripts/decision-sheet/markdown.ts";
import { plainText } from "../scripts/decision-sheet/refs.ts";
import {
  type Call,
  type DecisionSource,
  decisionStatus,
  facetLabel,
  parseSource,
  SourceError,
  STAKEHOLDER_FACETS,
  sentence,
  sheetTrigger,
} from "../scripts/decision-sheet/source.ts";
import { esc, PALETTE } from "../scripts/sheet-kit/html.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURES = join(import.meta.dir, "fixtures/decision-sheet");
const CLI = join(
  import.meta.dir,
  "../scripts/decision-sheet/decision-sheet.ts",
);
/**
 * The pilot sheet: the compact sheet of the pilot fixture with its embedded
 * source taken out, as a sheet made without the renderer carries none. Stored
 * as `.txt` so no linter or formatter rewrites it.
 */
const PILOT_SHEET = "pilot.sheet.html.txt";
const STE_LINT = join(import.meta.dir, "../scripts/ste-lint/ste-lint.ts");

const pilotJson = () =>
  JSON.parse(
    readFileSync(join(FIXTURES, "pilot.json"), "utf8"),
  ) as DecisionSource;
const pilot = () => parseSource(pilotJson());
const fixtureJson = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as DecisionSource;
/** The compact sheet of `source`: the first layout of the sheet. */
const compact = (source: DecisionSource) => renderHtml(source, "compact");

/** Visible text nodes of a sheet: no style, no title, no embedded source block. */
function textNodes(html: string): string[] {
  return html
    .replace(
      /<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<title[\s\S]*?<\/title>/g,
      "",
    )
    .split(/<[^>]+>/)
    .map((t) =>
      t
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** Every string leaf of a value, with its JSON path. */
function stringLeaves(value: unknown, path = "$"): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value))
    return value.flatMap((v, i) => stringLeaves(v, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) =>
      stringLeaves(v, `${path}.${k}`),
    );
  return [];
}

/** A second call for the pilot, so the multi-call layout runs on real content. */
function twoCallSource(): DecisionSource {
  const source = pilotJson();
  const first = source.calls[0] as Call;
  const second: Call = {
    id: "b",
    title: "Who clears the review queue",
    owners: ["technical"],
    question: "Who owns the needs_review queue after an import?",
    scenarios: [
      { id: "S1", label: "Large import", detail: "About 500 product lines." },
    ],
    options: [
      {
        id: "1",
        name: "The catalogue manager",
        summary: "The person who ran the import clears the queue.",
        keep: ["One owner per import."],
        pay: ["The queue waits for one person."],
        rightWhen: "Imports are rare.",
        outcomes: {
          S1: { kind: "human", text: "One person reviews every line" },
        },
      },
      {
        id: "2",
        name: "Any merchandiser",
        summary: "Every merchandiser of the team can clear the queue.",
        keep: ["The queue clears faster."],
        pay: ["No single owner."],
        rightWhen: "Imports are frequent.",
        outcomes: {
          S1: { kind: "neutral", text: "The work spreads over a team" },
        },
      },
    ],
    recommended: "1",
    why: "Imports are rare today.",
  };
  return {
    ...source,
    calls: [
      {
        ...first,
        title: "Which value wins",
        question: "Which value does the import use by default?",
      },
      second,
    ],
    interplay: [
      {
        from: "a",
        to: "b",
        text: "Call b exists only when call a chooses option 3.",
      },
    ],
  };
}

// A git hook exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE pointing at the
// real checkout; a scratch repository's `init`, `add` or `commit` inheriting
// them would write there instead. Every git subprocess this file starts gets
// this env.
const gitEnv = gitIdentityEnv();

/** A throwaway git repository holding `files` in one commit. */
function repoWith(files: Record<string, string>): {
  dir: string;
  commit: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "decision-sheet-fresh-"));
  const git = (...args: string[]) => {
    const r = spawnSync(
      "git",
      [
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", env: gitEnv },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  for (const [path, content] of Object.entries(files)) {
    spawnSync("mkdir", ["-p", join(dir, path, "..")]);
    writeFileSync(join(dir, path), content);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "facts");
  return { dir, commit: git("rev-parse", "HEAD") };
}
/** The pilot with every optional single-call field set, so none can go unrendered. */
function singleCallWithExtras(): DecisionSource {
  const source = pilotJson();
  const call = source.calls[0] as Call;
  call.title = "Which value wins";
  call.question = "Which value does the import use by default?";
  call.facts = [{ text: "A call-level fact.", source: "AGENTS.md" }];
  call.openInput = "The number of remaining mismatches.";
  source.settled = [{ text: "A settled claim.", source: "CONTEXT.md" }];
  source.interplay = [
    {
      from: "a",
      to: "ENG-215",
      text: "A limit on overselling narrows option 2.",
    },
  ];
  return source;
}

describe("pilot parity (compact template)", () => {
  /**
   * The stored pilot sheet holds no reworded label, so every one of its text
   * nodes, claim or label, must appear verbatim in the new render. Unlike the
   * byte-for-byte golden, this ignores markup and style, so it still names a
   * dropped claim after a deliberate change of layout.
   */
  it("every claim of the pilot sheet is on the rendered sheet", () => {
    const pilotNodes = textNodes(
      readFileSync(join(FIXTURES, PILOT_SHEET), "utf8"),
    );
    const rendered = textNodes(compact(pilot())).join("\n");
    // A parse that read nothing must not pass.
    expect(pilotNodes.length).toBeGreaterThan(100);
    const missing = pilotNodes.filter((node) => !rendered.includes(node));
    expect(missing).toEqual([]);
  });

  it("the pilot sheet carries every claim of the pilot source", () => {
    const sheet = textNodes(
      readFileSync(join(FIXTURES, PILOT_SHEET), "utf8"),
    ).join("\n");
    // Ids, URLs, dates, facets and kinds render in fixed forms, not verbatim.
    const skip = /\.(schema|id|url|kind|date|commit)$|\.owners\[\d+\]$/;
    const leaves = stringLeaves(pilotJson()).filter(
      ([path]) => !skip.test(path),
    );
    expect(leaves.length).toBeGreaterThan(60);
    const missing = leaves
      .filter(([, text]) => !sheet.includes(text.replace(/\s+/g, " ").trim()))
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });
});

/**
 * The pilot with reference tokens where it names an option, the way a source
 * names options. The pilot fixture itself stays token-free: it is the golden
 * input of the compact template.
 */
function withRefs(): DecisionSource {
  const source = pilotJson();
  source.myRead =
    "Count the remaining mismatches first. If they are few, choose {opt:4}. If they are many, choose {opt:3}. Do not keep {opt:1} or {opt:2} as an unattended default: each can show more stock without a choice for each line, in opposite directions.";
  const call = source.calls[0] as Call;
  const sub = call.subQuestions?.[0];
  if (sub) sub.byOption["3"] = "Rejecting is not necessary, as for {opt:4}.";
  return source;
}

describe("no claim absent from the source", () => {
  /**
   * Remove every source string, then every fixed label, from each rendered
   * piece. Only punctuation, digits, icons and markup may remain. Anything
   * else is a word the renderer added that neither the source nor the label
   * table holds.
   */
  function residue(
    source: DecisionSource,
    pieces: string[],
    markup: RegExp,
    escapeText: (text: string) => string = (text) => text,
  ): string[] {
    const fixed = [
      ...Object.values(LABEL),
      ...Object.values(COMMENT),
      ...Object.values(OUTCOME_WORD),
      ...Object.values(OUTCOME_ICON),
      ...STAKEHOLDER_FACETS.map(facetLabel),
      SHEET_FILENAME_SUFFIX,
      decisionStatus(source),
      "of",
      // The comment's heading for open inputs is `LABEL.openInput` without its colon.
      LABEL.openInput.replace(/:$/, ""),
    ];
    // A reference token reads as plain words in every projection, so each leaf also counts in that form.
    const leaves = stringLeaves(source).flatMap(([, v]) => [v, plainText(v)]);
    const strings = [...leaves, ...leaves.map(escapeText), ...fixed].sort(
      (a, b) => b.length - a.length,
    );
    return pieces
      .map((piece) =>
        strings.reduce((rest, s) => rest.split(s).join(" "), piece).trim(),
      )
      .filter((rest) => !markup.test(rest) && !/^[A-Z]$/.test(rest));
  }
  /**
   * The document sheet splits a sentence into several text nodes where a term
   * or a reference becomes a link, and a tip adds the term's meaning inside the
   * sentence. So its words are checked one by one: every word on the sheet is
   * a word of the source, of a reference token's plain form, or of the label
   * table. A word is a run of letters and digits, so a link that splits
   * "type's" into "type" and "'s" still matches. This cannot see a reordering, which the escaping test and the
   * ported-claims checks cover; it sees a word the renderer made up.
   */
  const WORD = /[\p{L}\p{N}]+/gu;
  function foreignWords(
    source: DecisionSource,
    nodes: string[],
    extra: string[],
  ): string[] {
    const allowed = new Set<string>();
    const add = (text: string) => {
      for (const w of text.match(WORD) ?? []) allowed.add(w);
    };
    for (const [, v] of stringLeaves(source)) {
      add(v);
      add(plainText(v));
    }
    for (const label of [
      ...Object.values(LABEL),
      ...Object.values(OUTCOME_WORD),
      ...STAKEHOLDER_FACETS.map(facetLabel),
      decisionStatus(source),
      ...extra,
    ])
      add(label);
    return [
      ...new Set(
        nodes
          .flatMap((n) => n.match(WORD) ?? [])
          .filter((w) => !allowed.has(w)),
      ),
    ];
  }
  /**
   * The claim-level half of the word check. A word list cannot see a made-up
   * sentence built from words the source already holds ("The supplier
   * wins."), so this cuts the sheet into runs of inline text (links, code and
   * emphasis; a term's wrapper is unwrapped), with the term tips taken out, and requires every three consecutive words of a run to
   * occur together in one source leaf, reference plain form or label. Links
   * and terms split a sentence into nodes but not a run, so a split sentence
   * still matches while an added claim does not.
   */
  /**
   * Whether an element cuts a run is read from its computed style in a real
   * DOM, not from the stylesheet text: selector context, `:not()`, attribute
   * selectors and `@media` conditions then apply as they do on the page, at a
   * desktop width and without hover or focus. An element cuts a run when it
   * lays out as anything but inline text: any display but `inline`, a float,
   * or an absolute or fixed position. A flex or grid container blockifies its
   * children, so they cut a run too. The DOM carries no user-agent defaults
   * for every element (a `th`), so only the tags that are inline text by
   * default (links, code, emphasis, bold, underline, small, mark, sub, sup,
   * spans) stay in a run unless the stylesheet says otherwise; any other tag, and any `hidden` element, always cuts one.
   */
  const INLINE_TAGS =
    /^(a|abbr|b|cite|code|dfn|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var)$/;
  const cutsRun = (
    window: Window,
    el: Element,
    parentIsFlex: boolean,
  ): boolean => {
    const style = window.getComputedStyle(el);
    const display = style.display || "inline";
    return (
      parentIsFlex ||
      !INLINE_TAGS.test(el.localName) ||
      el.hasAttribute("hidden") ||
      display !== "inline" ||
      !["", "none"].includes(style.float) ||
      ["absolute", "fixed"].includes(style.position)
    );
  };
  const isFlexDisplay = (window: Window, el: Element) =>
    /^(inline-)?(flex|grid)$/.test(window.getComputedStyle(el).display);
  function unsupportedClaims(
    source: DecisionSource,
    html: string,
    extra: string[],
  ): string[] {
    // The renderer joins two leaves with its own punctuation, so a triple never crosses a sentence mark.
    // A date, a decision id or a commit id is one structural token that cuts a run like a sentence mark.
    const STRUCTURAL =
      /[.!?:;]+(?:\s|$)|\b\d{4}-\d{2}-\d{2}\b|\b[A-Z][A-Z0-9]*-\d+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;
    // A number is literal: a renderer that turns "500 product lines" into "4 product lines" corrupts a quantity.
    const fragments = (text: string) =>
      text.split(STRUCTURAL).map((f) => f.match(WORD) ?? []);
    const known = new Set<string>();
    const addTriples = (text: string) => {
      for (const w of fragments(text))
        for (let i = 0; i + 3 <= w.length; i++)
          known.add(w.slice(i, i + 3).join(" "));
    };
    for (const [, v] of stringLeaves(source)) {
      addTriples(v);
      addTriples(plainText(v));
    }
    for (const label of [
      ...Object.values(LABEL),
      ...Object.values(OUTCOME_WORD),
      ...STAKEHOLDER_FACETS.map(facetLabel),
      decisionStatus(source),
      ...extra,
    ])
      addTriples(label);
    // Numbered labels ("Pick option 2"): the renderer appends or prepends the number.
    // The pick control's screen-reader name is two fixed labels and an option id ("Pick option 1").
    for (const call of source.calls)
      for (const option of call.options)
        addTriples(`${DOCUMENT_LABEL.pick} ${LABEL.refOption} ${option.id}`);
    for (const label of [...Object.values(LABEL), ...Object.values(extra)]) {
      addTriples(`${label} 0`);
      addTriples(`0 ${label}`);
    }
    const window = new Window({ width: 1280, height: 800 });
    window.document.write(html);
    const { document } = window;
    for (const el of [...document.querySelectorAll("script,title")])
      el.remove();
    for (const el of [...document.querySelectorAll("span.tip")]) el.remove();
    for (const el of [...document.querySelectorAll("a.chip,a.cchip")])
      el.replaceWith(document.createElement("br"));
    for (const el of [...document.querySelectorAll("span.tw")])
      el.replaceWith(...el.childNodes);
    const runs: string[] = [];
    let run = "";
    const cut = () => {
      runs.push(run);
      run = "";
    };
    const walk = (parent: Element, parentIsFlex: boolean) => {
      for (const node of [...parent.childNodes]) {
        if (node.nodeType === 3) {
          run += node.textContent ?? "";
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        const breaks = cutsRun(window, el, parentIsFlex);
        if (breaks) cut();
        walk(el, isFlexDisplay(window, el));
        if (breaks) cut();
      }
    };
    walk(document.body, false);
    runs.push(run);
    window.close();
    const bad: string[] = [];
    for (const r of runs) {
      for (const w of fragments(r))
        for (let i = 0; i + 3 <= w.length; i++) {
          const triple = w.slice(i, i + 3).join(" ");
          if (!known.has(triple))
            bad.push(`${triple} (in: ${r.trim().slice(0, 60)})`);
        }
    }
    return [...new Set(bad)];
  }
  const HTML_RESIDUE = /^[\s\d.·:@→+()-]*$/;
  const MD_RESIDUE = /^[\s\d.,·:@→+()\-*#|`[\]_\\]*$/;
  const mdEscape = (text: string) => text.replace(/[\\`*_[\]<>&|#~]/g, "\\$&");
  const lines = (md: string) => md.split("\n").filter((l) => l.trim() !== "");

  const ruled = () => {
    const source = twoCallSource();
    (source.calls[1] as Call).ruling = {
      option: "2",
      recordUrl: "https://tracker.example.com/acme/issue/ENG-210#comment-1",
      ruledAt: "2026-10-04",
    };
    return source;
  };
  const cases: [string, () => DecisionSource][] = [
    ["the single-call pilot", pilotJson],
    ["the pilot with reference tokens", withRefs],
    ["a single call with interplay and a title", singleCallWithExtras],
    ["a two-call source", twoCallSource],
    ["a two-call source with one call ruled", ruled],
    ["the seven-call source", () => fixtureJson("multicall.json")],
    ["the edge-case source", () => fixtureJson("edge-cases.json")],
  ];
  for (const template of SHEET_TEMPLATES)
    for (const [name, make] of cases) {
      it(`holds for ${name}: ${template} sheet`, () => {
        const source = parseSource(make());
        // The document sheet adds its own fixed words, and those are all in its label table.
        const nodes = textNodes(renderHtml(source, template));
        expect(nodes.length).toBeGreaterThan(50);
        if (template === "document") {
          // The hidden branches are numbered, so their ordinals are words the renderer adds.
          const ordinals = (source.hiddenBranches ?? []).map((_, i) =>
            String(i + 1),
          );
          expect(
            foreignWords(source, nodes, [
              ...Object.values(DOCUMENT_LABEL),
              ...ordinals,
            ]),
          ).toEqual([]);
          expect(
            unsupportedClaims(
              source,
              renderHtml(source, template),
              Object.values(DOCUMENT_LABEL),
            ),
          ).toEqual([]);
        } else expect(residue(source, nodes, HTML_RESIDUE)).toEqual([]);
      });
    }
  describe("the claim check rejects an added claim", () => {
    const source = () => parseSource(pilotJson());
    const labels = Object.values(DOCUMENT_LABEL);
    const inject = (add: string) => {
      const html = renderHtml(source(), "document");
      return html.replace(
        '<main class="sheet" id="top">',
        `<main class="sheet" id="top">${add}`,
      );
    };
    const claims = (add: string) =>
      unsupportedClaims(source(), inject(add), labels);
    it("passes the unmodified sheet (the control)", () => {
      expect(claims("")).toEqual([]);
    });
    it("a quantity appended to a sentence", () => {
      expect(claims("<p>Keep 4 boxes.</p>")).not.toEqual([]);
    });
    it("a sentence split over plain inline spans", () => {
      expect(
        claims("<p><span>The supplier</span> <span>wins.</span></p>"),
      ).not.toEqual([]);
    });
    it("a sentence split over an unstyled classed span", () => {
      expect(
        claims(
          '<p><span class="zz">The supplier</span> <span>wins.</span></p>',
        ),
      ).not.toEqual([]);
    });
    it("a sentence split over a span the stylesheet only restyles", () => {
      expect(
        claims('<p><span class="mono">The supplier</span> wins.</p>'),
      ).not.toEqual([]);
    });
    it("a sentence split over a span whose block rule needs another ancestor", () => {
      expect(
        claims('<p><span class="lab">The supplier</span> wins.</p>'),
      ).not.toEqual([]);
    });
    it("a sentence split over a span whose display rule is only a hover or pressed state", () => {
      expect(
        claims('<p><span class="un">The supplier</span> wins.</p>'),
      ).not.toEqual([]);
    });
    it("a span the stylesheet makes a block in its own context still cuts the run (the control)", () => {
      expect(
        claims(
          '<div class="side"><span class="lab">The supplier</span><p>wins.</p></div>',
        ),
      ).toEqual([]);
    });
    for (const tag of ["b", "u", "small", "mark", "sub", "sup"])
      it(`a sentence split over a default-inline <${tag}> is still one run`, () => {
        expect(
          claims(`<p><${tag}>The supplier</${tag}> wins.</p>`),
        ).not.toEqual([]);
      });
    it("a source quantity replaced by another number", () => {
      expect(
        claims("<p>A full catalogue has about 4 product lines.</p>"),
      ).not.toEqual([]);
    });
    it("the source quantity itself still passes (the control)", () => {
      expect(
        claims("<p>A full catalogue has about 500 product lines.</p>"),
      ).toEqual([]);
    });
  });
  for (const [name, make] of cases)
    it(`holds for ${name}: elaboration and comment`, () => {
      const source = parseSource(make());
      const pieces = [
        ...lines(renderElaboration(source)),
        ...lines(renderComment(source)),
      ];
      expect(residue(source, pieces, MD_RESIDUE, mdEscape)).toEqual([]);
    });
});

describe("HTML escaping", () => {
  /**
   * Mark every free-text leaf with a unique HTML fragment. The sheet must show
   * each mark escaped, and the elaboration must show each mark. So this test
   * proves both escaping and that no source text is left out of a projection.
   */
  const withSettled = () => {
    const source = twoCallSource();
    source.settled = [{ text: "Settled claim.", source: "AGENTS.md" }];
    return source;
  };
  for (const template of SHEET_TEMPLATES)
    for (const [name, make] of [
      ["two calls", withSettled],
      ["one call with every optional field", singleCallWithExtras],
      ["the seven-call source", () => fixtureJson("multicall.json")],
    ] as const)
      it(`escapes and renders every text field: ${name}, ${template} sheet`, () => {
        let n = 0;
        // Ids, URLs, dates, facets and kinds are validated to safe shapes and render in fixed forms.
        const skip =
          /\.(schema|id|url|recommended|option|kind|recordUrl|ruledAt|date|commit)$|\.owners\[\d+\]$/;
        const mark = (value: unknown, path: string): unknown => {
          if (typeof value === "string")
            return skip.test(path) ? value : `${value} <i x="${++n}">&'</i>`;
          if (Array.isArray(value))
            return value.map((v, i) => mark(v, `${path}[${i}]`));
          if (value && typeof value === "object")
            return Object.fromEntries(
              Object.entries(value).map(([k, v]) => [
                k,
                mark(v, `${path}.${k}`),
              ]),
            );
          return value;
        };
        const marked = parseSource(mark(make(), "$"));
        const html = renderHtml(marked, template);
        const md = renderElaboration(marked);
        expect(n).toBeGreaterThan(60);
        expect(html).not.toContain("<i x=");
        for (let i = 1; i <= n; i++) {
          expect([i, html.includes(esc(`<i x="${i}">&'</i>`))]).toEqual([
            i,
            true,
          ]);
          // A claim's source renders in a code span, where text is already literal.
          const raw = `<i x="${i}">&'</i>`;
          const literal =
            md.includes(`\\<i x="${i}"\\>\\&'\\</i\\>`) ||
            md.split("`").some((part, k) => k % 2 === 1 && part.includes(raw));
          expect([i, literal]).toEqual([i, true]);
        }
      });

  it("keeps block punctuation and link destinations literal in the markdown", () => {
    const source = twoCallSource();
    (source.calls[0] as Call).question =
      "Keep this\n\n---\n===\n- item\n1. one\n    indented";
    (source.calls[1] as Call).ruling = {
      option: "1",
      recordUrl: "https://example.test/r|a`b",
      ruledAt: "2026-10-04",
    };
    const md = renderElaboration(parseSource(source));
    expect(md).toContain(
      "Keep this\n\n\\---\n\\===\n\\- item\n1\\. one\nindented",
    );
    expect(md).toContain("(https://example.test/r%7Ca%60b)");
  });

  it("rejects a backslash in a ruling URL, which URL parsing reads as a slash", () => {
    const source = twoCallSource();
    (source.calls[1] as Call).ruling = {
      option: "1",
      recordUrl: "https://example.test/r\\",
      ruledAt: "2026-10-04",
    };
    expect(() => parseSource(source)).toThrow(/backslash/);
  });

  for (const template of SHEET_TEMPLATES)
    it(`keeps the embedded source inert and recoverable: ${template} sheet`, () => {
      const source = pilotJson();
      source.myRead =
        "Close the block early: </script><script>alert(1)</script> <!-- x";
      const html = renderHtml(parseSource(source), template);
      // The document sheet carries one more script: its own, which holds no source text.
      expect(html.match(/<script/g)).toHaveLength(
        template === "document" ? 2 : 1,
      );
      expect(extractSource(html)).toEqual(source);
      expect(extractTemplate(html)).toBe(template);
    });

  for (const template of SHEET_TEMPLATES)
    it(`puts no non-https URL in an href: ${template} sheet`, () => {
      const source = twoCallSource();
      (source.calls[1] as Call).ruling = {
        option: "1",
        recordUrl: "https://x.test/r",
        ruledAt: "2026-10-04",
      };
      expect(renderHtml(parseSource(source), template)).not.toMatch(
        /href="(?!https:|#)/,
      );
    });
});

describe("self-contained sheet", () => {
  for (const template of SHEET_TEMPLATES)
    it(`loads no external font, script, stylesheet or image: ${template} sheet`, () => {
      const html = renderHtml(parseSource(twoCallSource()), template);
      for (const re of [
        /<link/i,
        /<img/i,
        /\ssrc=/i,
        /url\(/i,
        /@import/i,
        /@font-face/i,
      ])
        expect(html).not.toMatch(re);
      expect(html.match(/<script[^>]*>/g)).toEqual(
        template === "document"
          ? [
              '<script type="application/json" id="decision-source" data-template="document">',
              "<script>",
            ]
          : ['<script type="application/json" id="decision-source">'],
      );
    });
});

describe("optional fields", () => {
  /** What each template shows for a field, as a marker in its HTML. */
  const MARK = {
    compact: {
      obligation: `<dt>${LABEL.obligation}</dt>`,
      tag: 'class="tag"',
      branches: 'data-panel="branches"',
      settled: 'data-panel="settled"',
      terms: `<h3>${LABEL.terms}</h3>`,
      followOn: 'data-panel="followon-',
      matrix: 'class="matrix"',
    },
    document: {
      obligation: `<h4 class="lab">${LABEL.obligation}</h4>`,
      tag: 'class="tag"',
      branches: 'id="before"',
      settled: 'id="settled"',
      terms: 'id="terms"',
      followOn: 'id="sq-',
      matrix: 'class="mx"',
    },
  } satisfies Record<SheetTemplate, Record<string, string>>;

  for (const template of SHEET_TEMPLATES) {
    const m = MARK[template];

    it(`leaves out an absent obligation, tag, settled list, branch list and glossary: ${template} sheet`, () => {
      const source = pilotJson();
      const call = source.calls[0] as Call;
      call.options = call.options.map(
        ({ obligation: _o, tag: _t, ...rest }) => rest,
      );
      delete source.hiddenBranches;
      delete source.glossary;
      delete call.subQuestions;
      delete call.notes;
      const parsed = parseSource(source);
      const html = renderHtml(parsed, template);
      expect(html).not.toContain(m.obligation);
      expect(html).not.toContain(m.tag);
      expect(html).not.toContain(m.branches);
      expect(html).not.toContain(m.settled);
      expect(html).not.toContain(m.terms);
      expect(html).not.toContain(m.followOn);
      // No region is left as an empty shell.
      expect(html).not.toContain('<div class="body"></div>');
      const md = renderElaboration(parsed);
      expect(md).not.toContain(`**${LABEL.obligation}:**`);
      expect(md).not.toContain(`## ${LABEL.hiddenBranches}`);
      expect(md).not.toContain(`## ${LABEL.terms}`);
    });

    it(`renders an obligation only on the options that have one: ${template} sheet`, () => {
      const html = renderHtml(pilot(), template);
      expect(html.split(m.obligation).length - 1).toBe(2);
    });

    it(`renders no matrix for a call without scenarios: ${template} sheet`, () => {
      const source = pilotJson();
      const call = source.calls[0] as Call;
      delete call.scenarios;
      delete call.outcomeMeaning;
      call.options = call.options.map(({ outcomes: _x, ...rest }) => rest);
      const html = renderHtml(parseSource(source), template);
      expect(html).not.toContain(m.matrix);
      expect(renderElaboration(parseSource(source))).not.toContain(
        `| ${LABEL.option} |`,
      );
    });
  }
});

describe("outcome matrix", () => {
  it("renders every option × scenario cell with an icon and a word: compact sheet", () => {
    const source = pilot();
    const call = source.calls[0] as Call;
    const html = compact(source);
    const scenarios = call.scenarios ?? [];
    expect(html.match(/<td class="cell /g)).toHaveLength(
      call.options.length * scenarios.length,
    );
    for (const o of call.options)
      for (const s of scenarios) {
        const outcome = o.outcomes?.[s.id];
        if (!outcome) throw new Error("fixture lost an outcome");
        expect(html).toContain(
          `<td class="cell ${outcome.kind}" data-option="${o.id}" data-scenario="${s.id}"><span class="ic" aria-hidden="true">${OUTCOME_ICON[outcome.kind]}</span><b>${OUTCOME_WORD[outcome.kind]}</b>`,
        );
      }
  });

  it("renders every option × scenario cell as a tinted tile with a glyph and a word: document sheet", () => {
    for (const make of [
      pilot,
      () => parseSource(fixtureJson("edge-cases.json")),
    ]) {
      const source = make();
      const call = source.calls[0] as Call;
      const html = renderHtml(source, "document");
      const scenarios = call.scenarios ?? [];
      // A count of zero must never pass.
      expect(scenarios.length).toBeGreaterThan(1);
      expect(html.match(/<td class="k-[a-z]+" data-s=/g)).toHaveLength(
        (source.calls as Call[])
          .filter((c) => c.scenarios?.length)
          .reduce(
            (n, c) => n + c.options.length * (c.scenarios?.length ?? 0),
            0,
          ),
      );
      for (const o of call.options)
        for (const s of scenarios) {
          const outcome = o.outcomes?.[s.id];
          if (!outcome) throw new Error("fixture lost an outcome");
          expect(html).toContain(
            `<td class="k-${outcome.kind}" data-s="${esc(s.label)}"><span class="ow">${OUTCOME_ICON[outcome.kind]} ${OUTCOME_WORD[outcome.kind]}</span>`,
          );
        }
    }
  });

  it("projects the same cells into the markdown table", () => {
    const md = renderElaboration(pilot());
    expect(md).toContain(
      "| 1. Warehouse wins | ✕ Risk: Higher than the supplier's own count | ✓ Safe: The lower warehouse count |",
    );
  });
});

describe("multi-call sheet", () => {
  it("renders one options panel and one matrix per call, and one interplay panel: compact sheet", () => {
    const html = compact(parseSource(twoCallSource()));
    expect(html.match(/data-panel="options-/g)).toHaveLength(2);
    expect(html.match(/<table class="matrix"/g)).toHaveLength(2);
    expect(html.match(/data-panel="interplay"/g)).toHaveLength(1);
    expect(html.match(/<main class="sheet"/g)).toHaveLength(3);
    expect(html).toContain("<div>3 of 3</div>");
  });

  it("renders one options region and one matrix per call, and one interplay region: document sheet", () => {
    const html = renderHtml(parseSource(twoCallSource()), "document");
    expect(html.match(/<div class="opts">/g)).toHaveLength(2);
    expect(html.match(/<table class="mx">/g)).toHaveLength(2);
    expect(html.match(/<section class="sec" id="interplay"/g)).toHaveLength(1);
    // One page: the calls are sections of it, not sheets.
    expect(html.match(/<main class="sheet"/g)).toHaveLength(1);
    expect(html.match(/<section class="call/g)).toHaveLength(2);
    // The call index lists each call once, and the top bar links to each.
    expect(html.match(/<tr data-t="c-[a-z]">/g)).toHaveLength(2);
    expect(html.match(/<a class="bar-c" href="#call-/g)).toHaveLength(2);
  });

  it("renders a single call as one sheet, as the pilot did", () => {
    const html = compact(pilot());
    expect(html.match(/<main class="sheet"/g)).toHaveLength(1);
    expect(html).not.toContain('data-panel="interplay"');
    const doc = renderHtml(pilot(), "document");
    expect(doc.match(/<main class="sheet"/g)).toHaveLength(1);
    expect(doc).not.toContain('id="interplay"');
    expect(doc).not.toContain('class="call');
  });
});

describe("status follows the ruling", () => {
  /** What each template marks on the chosen and the recommended option. */
  const TAG = {
    compact: {
      chosen: `<span class="rec">${LABEL.chosen}</span>`,
      recommended: `<span class="rec">${LABEL.recommended}</span>`,
    },
    document: {
      chosen: `<span class="tag tag-chosen">${LABEL.chosen}</span>`,
      recommended: `<span class="tag">${LABEL.recommended}</span>`,
    },
  } satisfies Record<SheetTemplate, Record<string, string>>;

  for (const template of SHEET_TEMPLATES) {
    it(`shows a ruled call as decided, with the record link and no recommendation: ${template} sheet`, () => {
      const source = twoCallSource();
      const ruled = source.calls[1] as Call;
      ruled.ruling = {
        option: "2",
        recordUrl: "https://tracker.example.com/acme/issue/ENG-210#comment-9",
        ruledAt: "2026-10-04",
      };
      const parsed = parseSource(source);
      const html = renderHtml(parsed, template);
      const text = textNodes(html).join("\n");
      expect(decisionStatus(parsed)).toBe("Partly decided: 1 of 2 calls ruled");
      expect(text).toContain("Partly decided: 1 of 2 calls ruled");
      expect(html).toContain(
        'href="https://tracker.example.com/acme/issue/ENG-210#comment-9"',
      );
      expect(text).not.toContain(ruled.why as string);
      const callB = html.slice(html.indexOf('id="call-b"'));
      expect(callB).toContain(TAG[template].chosen);
      expect(callB).not.toContain(TAG[template].recommended);
      expect(renderComment(parsed)).toContain(
        `${LABEL.decided} 2. Any merchandiser.`,
      );
      // The open call keeps its recommendation, and the overall read stays while a call is open.
      expect(text).toContain(parsed.myRead);
    });

    it(`drops the overall read once every call is ruled: ${template} sheet`, () => {
      const source = pilotJson();
      (source.calls[0] as Call).ruling = {
        option: "3",
        recordUrl: "https://x.test/r",
        ruledAt: "2026-10-04",
      };
      const parsed = parseSource(source);
      expect(decisionStatus(parsed)).toBe("Decided");
      expect(textNodes(renderHtml(parsed, template)).join("\n")).not.toContain(
        parsed.myRead,
      );
      expect(renderElaboration(parsed)).not.toContain(parsed.myRead);
    });
  }
});

describe("source validation", () => {
  const problems = (
    mutate: (s: DecisionSource & Record<string, unknown>) => void,
  ): string[] => {
    const source = twoCallSource() as DecisionSource & Record<string, unknown>;
    mutate(source);
    try {
      parseSource(source);
      return [];
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return err.problems;
    }
  };

  it("accepts both fixtures", () => {
    expect(problems(() => {})).toEqual([]);
    expect(() => pilot()).not.toThrow();
  });

  it("rejects an unknown field, so a typo cannot drop a claim", () => {
    expect(
      problems(
        (s) =>
          ((
            (s.calls[0] as Call).options[0] as unknown as Record<
              string,
              unknown
            >
          ).obligaton = "x"),
      ),
    ).toEqual(["$.calls[0].options[0].obligaton: unknown field"]);
  });

  it("rejects a missing matrix cell and an unknown outcome kind", () => {
    expect(
      problems((s) => delete (s.calls[0] as Call).options[0]?.outcomes?.A),
    ).toContain("$.calls[0].options[0].outcomes.A: is required");
    expect(
      problems(
        (s) =>
          ((
            (s.calls[0] as Call).options[0]?.outcomes?.A as { kind: string }
          ).kind = "shortens"),
      ),
    ).toContain(
      "$.calls[0].options[0].outcomes.A.kind: must be one of safe, risk, human, neutral",
    );
  });

  it("rejects a recommendation or ruling that names no option", () => {
    expect(problems((s) => ((s.calls[1] as Call).recommended = "9"))).toContain(
      "$.calls[1].recommended: must name an option id of this call",
    );
    expect(
      problems(
        (s) =>
          ((s.calls[1] as Call).ruling = {
            option: "9",
            recordUrl: "https://x.test",
            ruledAt: "2026-10-04",
          }),
      ),
    ).toContain(
      "$.calls[1].ruling.option: must name an option id of this call",
    );
  });

  it("requires interplay, titles and questions once there are two calls", () => {
    expect(problems((s) => delete s.interplay)).toContain(
      "$.interplay: is required when the source has two or more calls",
    );
    expect(problems((s) => delete (s.calls[1] as Call).title)).toContain(
      "$.calls[1].title: is required",
    );
  });

  it("requires call owners to be owners of the decision", () => {
    expect(
      problems((s) => ((s.calls[1] as Call).owners = ["legal"])),
    ).toContain("$.calls[1].owners: legal is not an owner of the decision");
    expect(
      problems((s) => ((s as { owners: string[] }).owners = ["Technical"])),
    ).toContain(
      "$.owners[0]: must be one of product, technical, tactical, legal, compliance, commercial",
    );
  });

  it("requires an answer per option for every sub-question", () => {
    expect(
      problems(
        (s) => delete (s.calls[0] as Call).subQuestions?.[0]?.byOption["4"],
      ),
    ).toContain("$.calls[0].subQuestions[0].byOption.4: is required");
  });
});

describe("trigger rule", () => {
  const cases: [string, Parameters<typeof sheetTrigger>[0], boolean][] = [
    [
      "one facet, two options",
      {
        stakeholderFacets: ["technical"],
        optionCounts: [2],
        humanAsked: false,
      },
      false,
    ],
    [
      "two facets",
      {
        stakeholderFacets: ["compliance", "product"],
        optionCounts: [2],
        humanAsked: false,
      },
      true,
    ],
    [
      "the same facet twice",
      {
        stakeholderFacets: ["legal", "legal"],
        optionCounts: [2],
        humanAsked: false,
      },
      false,
    ],
    [
      "three options",
      {
        stakeholderFacets: ["technical"],
        optionCounts: [2, 3],
        humanAsked: false,
      },
      true,
    ],
    [
      "a human asked",
      { stakeholderFacets: ["technical"], optionCounts: [2], humanAsked: true },
      true,
    ],
    [
      "no facets, no calls",
      { stakeholderFacets: [], optionCounts: [], humanAsked: false },
      false,
    ],
  ];
  for (const [name, input, expected] of cases)
    it(`${name} → ${expected ? "sheet" : "no sheet"}`, () => {
      const result = sheetTrigger(input);
      expect(result.sheet).toBe(expected);
      expect(result.reasons.length > 0).toBe(expected);
    });
});

describe("attachment replacement", () => {
  const title = sheetAttachmentTitle("ENG-210");
  const rows = [
    { id: "old", title },
    { id: "pr", title: "feat: something" },
    { id: "new", title },
    { id: "untitled", title: null },
  ];

  it("deletes every older sheet and nothing else", () => {
    expect(staleSheetAttachments(rows, "new")).toEqual(["old"]);
  });

  it("refuses when the new sheet is not on the issue, or is not a sheet", () => {
    expect(() => staleSheetAttachments(rows, "missing")).toThrow(
      /not on the issue/,
    );
    expect(() => staleSheetAttachments(rows, "pr")).toThrow(/not titled/);
  });
});

describe("freshness guard", () => {
  it("extracts repository paths from claim sources", () => {
    const source = pilot();
    source.currentBehaviour.push(
      { text: "x", source: "AGENTS.md § Task Management" },
      { text: "x", source: "schema.ts orders; ADR-0032; v1.2" },
      {
        text: "x",
        source: "tools/db/migrations/0003_x.sql:12-40, see also docs/a.md#b",
      },
    );
    expect(citedPaths(source)).toEqual([
      "AGENTS.md",
      "apps/admin/src/components/import/import-conflict-step.tsx",
      "docs/a.md",
      "schema.ts",
      "services/api/src/routes/import.routes.ts",
      "services/catalog/src/import/import-executor.ts",
      "tools/db/migrations/0003_x.sql",
    ]);
  });

  it("names a cited file that changed after the verified commit, and one it cannot resolve", () => {
    const { dir, commit } = repoWith({ "src/a.ts": "one", "src/b.ts": "two" });
    writeFileSync(join(dir, "src/b.ts"), "changed");
    const source = pilot();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [
      { text: "x", source: "src/a.ts#f" },
      { text: "y", source: "src/b.ts:3" },
      { text: "z", source: "src/gone.ts" },
    ];
    expect(checkFreshness(source, dir)).toEqual({
      commit,
      checked: ["src/a.ts", "src/b.ts"],
      unresolved: ["src/gone.ts"],
      changed: ["src/b.ts"],
    });
  });

  it("does not read sentence-ending punctuation as part of a citation", () => {
    const { dir, commit } = repoWith({
      "src/a.ts": "one",
      "apps/web/Dockerfile": "two",
    });
    const source = pilot();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [
      { text: "x", source: "See src/a.ts. And apps/web/Dockerfile." },
    ];
    expect(checkFreshness(source, dir)).toEqual({
      commit,
      checked: ["apps/web/Dockerfile", "src/a.ts"],
      unresolved: [],
      changed: [],
    });
  });

  it("reports an extensionless citation absent at the verified commit as unresolved", () => {
    const { dir, commit } = repoWith({ "apps/web/Dockerfile": "one" });
    const source = pilot();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [
      { text: "x", source: "apps/web/Dockerfile" },
      { text: "y", source: "apps/api/Dockerfile" },
    ];
    expect(checkFreshness(source, dir)).toEqual({
      commit,
      checked: ["apps/web/Dockerfile"],
      unresolved: ["apps/api/Dockerfile"],
      changed: [],
    });
  });

  it("throws on a commit the clone does not have, instead of reporting no change", () => {
    const { dir } = repoWith({ "src/a.ts": "one" });
    const source = pilot();
    source.verifiedAt.commit = "deadbeefdeadbeef";
    expect(() => checkFreshness(source, dir)).toThrow(/not in this clone/);
  });
});

describe("CLI", () => {
  it("renders three files and reports the attachment to upload", () => {
    const out = mkdtempSync(join(tmpdir(), "decision-sheet-cli-"));
    const r = spawnSync(
      "bun",
      [CLI, "render", join(FIXTURES, "pilot.json"), "--out", out],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const summary = JSON.parse(r.stdout);
    expect(summary.attachment.title).toBe("Decision sheet: ENG-210");
    expect(summary.attachment.contentType).toBe("text/html");
    expect(summary.trigger.sheet).toBe(true);
    const html = readFileSync(join(out, "ENG-210-decision-sheet.html"), "utf8");
    expect(summary.attachment.size).toBe(Buffer.byteLength(html));
    expect(readFileSync(join(out, "ENG-210-comment.md"), "utf8")).toContain(
      "ENG-210-decision-sheet.html",
    );
    const extracted = spawnSync(
      "bun",
      [CLI, "extract", join(out, "ENG-210-decision-sheet.html")],
      { encoding: "utf8" },
    );
    expect(JSON.parse(extracted.stdout)).toEqual(pilotJson());
  });

  it("exits 1 with every problem on an invalid source", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-sheet-bad-"));
    const bad = { ...pilotJson(), status: "Open" };
    writeFileSync(join(dir, "bad.json"), JSON.stringify(bad));
    const r = spawnSync(
      process.execPath,
      [CLI, "validate", join(dir, "bad.json")],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("$.status: unknown field");
  });
});

describe("STE linter on the markdown projections", () => {
  function lint(text: string) {
    const r = spawnSync(process.execPath, [STE_LINT, "--json"], {
      input: text,
      encoding: "utf8",
    });
    expect([0, 1]).toContain(r.status ?? -1);
    return (JSON.parse(r.stdout) as { violations: { rule: string }[] })
      .violations;
  }

  for (const [name, render] of [
    ["elaboration", renderElaboration],
    ["comment", renderComment],
  ] as const)
    it(`the pilot ${name} has no long sentence and no semicolon`, () => {
      const hard = lint(render(pilot())).filter(
        (v) => v.rule === "long-sentence" || v.rule === "semicolon",
      );
      expect(hard).toEqual([]);
    });

  it("the linter does flag the projection when the source has a long sentence", () => {
    const source = pilotJson();
    source.myRead = `${"word ".repeat(30).trim()}.`;
    expect(
      lint(renderComment(parseSource(source))).map((v) => v.rule),
    ).toContain("long-sentence");
  });
});

describe("palette", () => {
  /** WCAG 2.1 relative luminance contrast against white. */
  function contrastOnWhite(hex: string): number {
    const lin = (c: number) =>
      c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    const [r, g, b] = [1, 3, 5].map((i) =>
      lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255),
    ) as [number, number, number];
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
  }

  it("every outcome colour and the muted text meet WCAG AA on white", () => {
    for (const hex of [
      ...Object.values(OUTCOME_COLOUR),
      PALETTE.muted,
      PALETTE.ink,
    ])
      expect([hex, contrastOnWhite(hex) >= 4.5]).toEqual([hex, true]);
  });
});

describe("validator: outcome meanings, dates, URLs and prototype keys", () => {
  const problems = (
    mutate: (s: DecisionSource) => void,
    base = twoCallSource,
  ): string[] => {
    const source = base();
    mutate(source);
    try {
      parseSource(source);
      return [];
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return err.problems;
    }
  };

  it("rejects an outcome meaning that no projection could show", () => {
    expect(
      problems((s) => {
        (s.calls[0] as Call).outcomeMeaning = { neutral: "never used" };
      }),
    ).toContain(
      "$.calls[0].outcomeMeaning.neutral: no outcome of this call has this kind",
    );
    expect(
      problems((s) => {
        const call = s.calls[1] as Call;
        delete call.scenarios;
        call.options = call.options.map(({ outcomes: _x, ...rest }) => rest);
        call.outcomeMeaning = { safe: "x" };
      }),
    ).toContain("$.calls[1].outcomeMeaning: the call has no scenarios");
  });

  it("rejects an impossible date and a URL that breaks a markdown link", () => {
    const rule = (recordUrl: string, ruledAt: string) =>
      problems((s) => {
        (s.calls[1] as Call).ruling = { option: "1", recordUrl, ruledAt };
      });
    expect(rule("https://x.test/r", "2026-99-99")).toContain(
      "$.calls[1].ruling.ruledAt: must be a real YYYY-MM-DD date",
    );
    expect(rule("https://x.y/a) b", "2026-10-04")).toContain(
      "$.calls[1].ruling.recordUrl: must be an https URL with no spaces, parentheses or backslashes",
    );
    expect(problems((s) => (s.verifiedAt.date = "2026-02-30"))).toContain(
      "$.verifiedAt.date: must be a real YYYY-MM-DD date",
    );
  });

  it("reads an id that names an Object prototype key as a missing key", () => {
    expect(
      problems((s) => {
        const sub = (s.calls[0] as Call).subQuestions?.[0];
        if (sub) delete sub.byOption["1"];
        (s.calls[0] as Call).options[0] = {
          ...((s.calls[0] as Call).options[0] as Call["options"][number]),
          id: "toString",
        };
      }),
    ).toContain("$.calls[0].subQuestions[0].byOption.toString: is required");
  });
});

describe("freshness: citation tokens", () => {
  it("keeps every file with an extension and every directory, slash or not", () => {
    const source = pilot();
    source.currentBehaviour = [
      { text: "x", source: "package.json" },
      { text: "x", source: "mise.toml, turbo.json#tasks" },
      { text: "x", source: "apps/backend/src/routes/ (all routes)" },
      { text: "x", source: "v1.2 of the spec, confidence 1.0" },
    ];
    expect(citedPaths(source)).toEqual([
      "apps/backend/src/routes/",
      "mise.toml",
      "package.json",
      "turbo.json",
    ]);
  });
});

describe("CLI: freshness, flags and the helper commands", () => {
  const run = (args: string[], cwd: string, input?: string) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: "utf8",
      input,
      env: gitEnv,
    });

  function staleRepo(cited: string) {
    const { dir, commit } = repoWith({ "src/a.ts": "one" });
    const source = pilotJson();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [{ text: "A claim.", source: cited }];
    writeFileSync(join(dir, "decision.json"), JSON.stringify(source));
    return dir;
  }

  it("--require-fresh exits 3 and writes nothing when a cited file changed", () => {
    const dir = staleRepo("src/a.ts#f");
    writeFileSync(join(dir, "src/a.ts"), "changed");
    const r = run(
      ["render", "decision.json", "--require-fresh", "--out", "out"],
      dir,
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("src/a.ts");
    expect(spawnSync("ls", [join(dir, "out")]).status).not.toBe(0);
  });

  it("--require-fresh checks the checkout it runs in when git variables point at another", () => {
    const dir = staleRepo("src/a.ts#f");
    const other = repoWith({ "src/a.ts": "other" }).dir;
    const r = spawnSync(
      process.execPath,
      [CLI, "render", "decision.json", "--require-fresh", "--out", "out"],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...gitEnv,
          GIT_DIR: join(other, ".git"),
          GIT_WORK_TREE: other,
        },
      },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).freshness.changed).toEqual([]);
  });

  it("--require-fresh checks GROUNDWORK_CONSUMER_ROOT rather than the working directory", () => {
    const consumer = staleRepo("src/a.ts#f");
    const elsewhere = repoWith({ "src/a.ts": "other" }).dir;
    const r = spawnSync(
      process.execPath,
      [
        CLI,
        "render",
        join(consumer, "decision.json"),
        "--require-fresh",
        "--out",
        join(consumer, "out"),
      ],
      {
        cwd: elsewhere,
        encoding: "utf8",
        env: { ...gitEnv, GROUNDWORK_CONSUMER_ROOT: consumer },
      },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).freshness.changed).toEqual([]);
  });

  it("--require-fresh exits 3 when a cited path cannot be resolved", () => {
    const r = run(
      ["render", "decision.json", "--require-fresh", "--out", "out"],
      staleRepo("a.ts"),
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("cannot check them");
  });

  it("rejects a misspelled flag instead of ignoring it", () => {
    const dir = staleRepo("src/a.ts");
    const r = run(
      ["render", "decision.json", "--require-fersh", "--out", "out"],
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag for render: --require-fersh");
    expect(spawnSync("ls", [join(dir, "out")]).status).not.toBe(0);
  });

  it("rejects a misspelled flag that follows a repeated value flag", () => {
    const dir = staleRepo("src/a.ts");
    const r = run(
      ["render", "decision.json", "--out", "out", "--out", "--require-fersh"],
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown flag for render: --require-fersh");
    expect(spawnSync("ls", [join(dir, "out")]).status).not.toBe(0);
  });

  it("rejects a repeated flag instead of reading only the first", () => {
    const dir = staleRepo("src/a.ts");
    const r = run(
      ["render", "decision.json", "--out", "out", "--out", "o2"],
      dir,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("flag given more than once for render: --out");
    expect(spawnSync("ls", [join(dir, "out")]).status).not.toBe(0);
  });

  it("--require-fresh renders when every citation is unchanged", () => {
    const r = run(
      ["render", "decision.json", "--require-fresh", "--out", "out"],
      staleRepo("src/a.ts"),
    );
    expect(r.status).toBe(0);
  });

  it("stale-attachments reads an issue from stdin", () => {
    const issue = {
      attachments: [
        { id: "a1", title: sheetAttachmentTitle("ENG-1") },
        { id: "a2", title: sheetAttachmentTitle("ENG-1") },
        { id: "pr", title: "feat: x" },
      ],
    };
    const r = run(
      ["stale-attachments", "--keep", "a2"],
      REPO_ROOT,
      JSON.stringify(issue),
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["a1"]);
  });

  it("trigger accepts hitl: prefixes and rejects a label that is not a facet", () => {
    const ok = run(
      ["trigger", "--facets", "hitl:compliance,product", "--options", "2"],
      REPO_ROOT,
    );
    expect(JSON.parse(ok.stdout).sheet).toBe(true);
    const bad = run(
      ["trigger", "--facets", "compliance,agent:architect", "--options", "2"],
      REPO_ROOT,
    );
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("agent:architect");
  });
});

describe("projections: costs and empty panels", () => {
  it("the comment carries no option costs", () => {
    for (const source of [pilot(), parseSource(twoCallSource())]) {
      const comment = renderComment(source);
      for (const call of source.calls)
        for (const o of call.options)
          for (const text of [
            ...o.keep,
            ...o.pay,
            o.rightWhen,
            o.obligation ?? "",
          ].filter(Boolean))
            expect([text, comment.includes(text)]).toEqual([text, false]);
    }
  });

  for (const template of SHEET_TEMPLATES)
    it(`a fully ruled multi-call overview has no empty panel: ${template} sheet`, () => {
      const source = twoCallSource();
      delete source.glossary;
      for (const call of source.calls)
        call.ruling = {
          option: "1",
          recordUrl: "https://x.test/r",
          ruledAt: "2026-10-04",
        };
      const html = renderHtml(parseSource(source), template);
      expect(html).not.toContain('<div class="body"></div>');
      expect(html).not.toContain('data-panel="recommendation"');
      // Nothing is left to recommend, so the recommendation is gone from the document sheet too.
      expect(html).not.toContain(
        `<h3 class="lab">${LABEL.recommendation}</h3>`,
      );
    });
});

describe("citations, markdown escaping and owners", () => {
  it("recognises dollar-prefixed routes, dotfiles and extensionless paths, and resolves ADR ids", () => {
    const { dir, commit } = repoWith({
      "apps/web/$productId.tsx": "a",
      ".gitignore": "b",
      "apps/web/Dockerfile": "c",
      "docs/adr/ADR-0017-clock.md": "d",
    });
    const source = pilot();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [
      { text: "x", source: "apps/web/$productId.tsx#loader" },
      { text: "x", source: ".gitignore, apps/web/Dockerfile" },
      { text: "x", source: "ADR-0017; ADR-9999" },
    ];
    expect(citedPaths(source)).toEqual([
      ".gitignore",
      "apps/web/$productId.tsx",
      "apps/web/Dockerfile",
    ]);
    const result = checkFreshness(source, dir);
    expect(result.checked).toEqual([
      ".gitignore",
      "apps/web/$productId.tsx",
      "apps/web/Dockerfile",
      "docs/adr/ADR-0017-clock.md",
    ]);
    expect(result.unresolved).toEqual(["ADR-9999"]);
    writeFileSync(join(dir, "docs/adr/ADR-0017-clock.md"), "changed");
    expect(checkFreshness(source, dir).changed).toEqual([
      "docs/adr/ADR-0017-clock.md",
    ]);
  });

  it("recognises citations separated by commas and semicolons", () => {
    const source = pilot();
    source.currentBehaviour = [
      { text: "x", source: "src/a.ts,src/b.ts;src/c.ts" },
    ];
    expect(citedPaths(source)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("recognises a citation inside square brackets", () => {
    const source = pilot();
    source.currentBehaviour = [
      { text: "x", source: "see [AGENTS.md:33] and [docs/a/]" },
    ];
    expect(citedPaths(source)).toEqual(["AGENTS.md", "docs/a/"]);
  });

  it("takes a backticked path with a space as one citation", () => {
    const source = pilot();
    source.currentBehaviour = [
      { text: "x", source: "`.run/Backend Dev.run.xml`#top, src/a.ts" },
    ];
    expect(citedPaths(source)).toEqual([
      ".run/Backend Dev.run.xml",
      "src/a.ts",
    ]);
  });

  it("does not read a closing backtick as the opening of the next span", () => {
    const source = pilot();
    source.currentBehaviour = [
      { text: "x", source: "`AGENTS.md` and `CONTEXT.md`" },
      {
        text: "y",
        source: "`AGENTS.md`, `.run/Backend Dev.run.xml`",
      },
    ];
    expect(citedPaths(source)).toEqual([
      ".run/Backend Dev.run.xml",
      "AGENTS.md",
      "CONTEXT.md",
    ]);
  });

  it("renders to an explicit --out outside a git checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "decision-sheet-nogit-"));
    const out = join(dir, "out");
    const r = spawnSync(
      "bun",
      [CLI, "render", join(FIXTURES, "pilot.json"), "--out", out],
      { cwd: dir, encoding: "utf8", env: gitEnv },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).freshness.error).toContain("git repository");
  });

  it("reports an untracked file added under a cited directory", () => {
    const { dir, commit } = repoWith({ "src/routes/a.ts": "one" });
    writeFileSync(join(dir, "src/routes/new.ts"), "two");
    const source = pilot();
    source.verifiedAt.commit = commit;
    source.currentBehaviour = [{ text: "x", source: "src/routes/ (all)" }];
    expect(checkFreshness(source, dir).changed).toEqual(["src/routes/new.ts"]);
  });

  it("keeps source text literal in markdown", () => {
    const source = pilotJson();
    source.question = "Pick <!-- hidden --> ![x](https://e.test/i.png) a\\|b";
    (source.calls[0] as Call).options[0]!.name = "Back\\|slash";
    const parsed = parseSource(source);
    for (const md of [renderElaboration(parsed), renderComment(parsed)]) {
      expect(md).toContain("Pick \\<!-- hidden --\\> !\\[x\\]");
      expect(md).not.toMatch(/(^|[^\\\\])<!--/);
    }
    const table = twoCallSource();
    (table.calls[0] as Call).title = "a\\|b";
    (table.calls[1] as Call).ruling = {
      option: "1",
      recordUrl: "https://example.test/r|other",
      ruledAt: "2026-10-04",
    };
    const out = renderComment(parseSource(table));
    expect(out).toContain("(a) a\\\\\\|b");
    expect(out).toContain("(https://example.test/r%7Cother)");
  });

  it("shows the owners of a lone call, not of the whole decision", () => {
    const source = pilotJson();
    source.owners = ["product", "compliance"];
    (source.calls[0] as Call).owners = ["compliance"];
    const parsed = parseSource(source);
    expect(renderComment(parsed)).toContain(
      `${LABEL.owners}:** ${facetLabel("compliance")}.`,
    );
    expect(compact(parsed)).toContain(
      `<div>${esc(facetLabel("compliance"))}</div>`,
    );
    const doc = renderHtml(parsed, "document");
    expect(doc).toContain(
      `<dd><span class="own" data-t="w-compliance">${esc(facetLabel("compliance"))}</span></dd>`,
    );
    expect(doc).not.toContain('data-t="w-product"');
  });

  it("rejects an issue URL that is not a real https URL", () => {
    for (const url of ["https://", "https://not a valid host"])
      expect(() => {
        const source = pilotJson();
        source.url = url;
        parseSource(source);
      }).toThrow(SourceError);
  });
});

describe("punctuation and the long-facts layout", () => {
  it("adds a period only when the text has no terminal punctuation", () => {
    expect(sentence("Retire the clients")).toBe("Retire the clients.");
    expect(sentence("Does a planned flow call these clients?")).toBe(
      "Does a planned flow call these clients?",
    );
    expect(sentence("No priority. Cost of delay: none.")).toBe(
      "No priority. Cost of delay: none.",
    );
    expect(sentence('It says "stop."')).toBe('It says "stop."');
    expect(sentence("Open input: ")).toBe("Open input:");
    expect(sentence("It says “stop.”")).toBe("It says “stop.”");
    expect(sentence("Who owns this?”")).toBe("Who owns this?”");
    expect(sentence("Trailing off…")).toBe("Trailing off…");
  });

  it("renders no doubled punctuation after a title, priority or option name that ends in one", () => {
    const source = twoCallSource();
    source.priority = "Low. No cost of delay.";
    source.hiddenBranches = [
      {
        title: "Does a planned flow call these clients?",
        text: "Text.",
        action: "Check.",
      },
    ];
    const call = source.calls[1] as Call;
    (call.options[0] as Call["options"][number]).name =
      "Is it the catalogue manager?";
    const sub: NonNullable<Call["subQuestions"]>[number] = {
      title: "API callers?",
      question: "Must it fail?",
      byOption: { "1": "Yes.", "2": "No." },
    };
    call.subQuestions = [sub];
    const parsed = parseSource(source);
    for (const out of [
      renderElaboration(parsed),
      renderComment(parsed),
      ...SHEET_TEMPLATES.map((t) =>
        textNodes(renderHtml(parsed, t)).join("\n"),
      ),
    ])
      expect(out).not.toMatch(/[.?!:]\.(?![.\w])|\?\.\*\*/);
  });

  it("puts a long question panel above the matrix instead of beside it (compact sheet)", () => {
    const short = compact(pilot());
    expect(short).toContain('class="panel span-1" data-panel="question"');
    expect(short).toContain('class="panel span-2" data-panel="matrix-a"');
    const source = pilotJson();
    source.currentBehaviour = Array.from(
      { length: SIDE_BY_SIDE_MAX_CLAIMS + 1 },
      (_, i) => ({
        text: `Claim ${i}.`,
        source: "AGENTS.md",
      }),
    );
    const long = compact(parseSource(source));
    expect(long).toContain('class="panel span-3" data-panel="question"');
    expect(long).toContain('class="panel span-3" data-panel="matrix-a"');
  });

  it("applies the same long-facts layout to each call of a multi-call sheet (compact sheet)", () => {
    const source = twoCallSource();
    const [first] = source.calls;
    if (!first?.scenarios?.length) throw new Error("fixture needs a matrix");
    const facts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        text: `Fact ${i}.`,
        source: "AGENTS.md",
      }));
    first.facts = facts(SIDE_BY_SIDE_MAX_CLAIMS);
    const short = compact(parseSource(source));
    expect(short).toContain(
      `class="panel span-1" data-panel="call-${first.id}"`,
    );
    first.facts = facts(SIDE_BY_SIDE_MAX_CLAIMS + 1);
    const long = compact(parseSource(source));
    expect(long).toContain(
      `class="panel span-3" data-panel="call-${first.id}"`,
    );
    expect(long).toContain(
      `class="panel span-3" data-panel="matrix-${first.id}"`,
    );
  });
});

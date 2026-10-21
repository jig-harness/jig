/**
 * Suite for the document template of the decision sheet and its explicit
 * reference tokens. The shared behaviour of both templates (escaping,
 * every field rendered, no claim absent from the source) is in
 * `decision-sheet.test.ts`, which runs each check once per template. This file
 * holds what only the document template, the `--template` flag or a reference
 * token does. The checks that need a real browser are in
 * `decision-sheet-browser.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderHtml } from "../scripts/decision-sheet/html.ts";
import {
  HIGHLIGHT_ROW,
  TEXT_PAIRS,
} from "../scripts/decision-sheet/html-document-css.ts";
import {
  extractSource,
  extractTemplate,
  OUTCOME_COLOUR,
} from "../scripts/decision-sheet/html-shared.ts";
import { DOCUMENT_LABEL, LABEL } from "../scripts/decision-sheet/labels.ts";
import {
  renderComment,
  renderElaboration,
} from "../scripts/decision-sheet/markdown.ts";
import {
  plainSource,
  plainText,
  refProblems,
  refWords,
  splitRefs,
} from "../scripts/decision-sheet/refs.ts";
import {
  type Call,
  type DecisionSource,
  parseSource,
  SourceError,
} from "../scripts/decision-sheet/source.ts";
import { OUTCOME_INK, TOKEN_TINTS } from "../scripts/sheet-kit/css.ts";
import { PALETTE } from "../scripts/sheet-kit/html.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const FIXTURES = join(import.meta.dir, "fixtures/decision-sheet");
const CLI = join(
  import.meta.dir,
  "../scripts/decision-sheet/decision-sheet.ts",
);

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as DecisionSource;
const pilotJson = () => fixture("pilot.json");

/** The pilot, the way a source reads once it names options with tokens. */
function pilotWithRefs(): DecisionSource {
  const source = pilotJson();
  source.myRead =
    "Count the remaining mismatches first. If they are few, choose {opt:4}. If they are many, choose {opt:3}. Do not keep {opt:1} or {opt:2} as an unattended default.";
  return source;
}

/** The pilot plus a second call, so a source has two calls named a and b. */
function twoCalls(): DecisionSource {
  const source = pilotJson();
  const first = source.calls[0] as Call;
  first.title = "Which value wins";
  first.question = "Which value does the import use by default?";
  source.calls = [
    first,
    {
      id: "b",
      title: "Who clears the queue",
      question: "Who owns the needs_review queue?",
      options: [
        {
          id: "1",
          name: "The manager",
          summary: "The importer clears it.",
          keep: ["One owner."],
          pay: ["A wait."],
          rightWhen: "Imports are rare.",
        },
        {
          id: "2",
          name: "Any merchandiser",
          summary: "Anyone clears it.",
          keep: ["Speed."],
          pay: ["No owner."],
          rightWhen: "Imports are frequent.",
        },
      ],
      recommended: "1",
      why: "Imports are rare today.",
    },
  ];
  source.interplay = [
    {
      from: "a",
      to: "b",
      text: "Call b exists only when {call:a,opt:3} wins.",
    },
  ];
  return source;
}

const nodes = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "")
    .split(/<[^>]+>/)
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);

describe("compact template is unchanged", () => {
  it("renders the pilot byte-for-byte as it did before the document template", () => {
    // The golden file is the output of the compact renderer on the pilot
    // fixture, so a change to the document template cannot change it. Stored
    // as `.txt` so no formatter rewrites it.
    const golden = readFileSync(
      join(FIXTURES, "pilot.compact.html.txt"),
      "utf8",
    );
    expect(golden.length).toBeGreaterThan(20000);
    expect(renderHtml(parseSource(pilotJson()), "compact")).toBe(golden);
  });

  it("records no template in the sheet, so a sheet without one reads as compact", () => {
    const html = renderHtml(parseSource(pilotJson()), "compact");
    expect(html).not.toContain("data-template");
    expect(extractTemplate(html)).toBe("compact");
  });
});

describe("reference tokens: validation", () => {
  const problems = (mutate: (s: DecisionSource) => void, base = twoCalls) => {
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

  it("accepts a token for an option and a call that exist", () => {
    expect(problems(() => {}, pilotWithRefs)).toEqual([]);
    expect(problems(() => {})).toEqual([]);
    expect(
      problems((s) => {
        (s.calls[1] as Call).why =
          "Because {opt:2} is slower than {call:a,opt:1}.";
        (s.calls[0] as Call).notes = ["See {call:b}."];
      }),
    ).toEqual([]);
  });

  it("rejects an option that does not exist", () => {
    expect(
      problems((s) => {
        s.myRead = "Choose {opt:9}.";
      }, pilotWithRefs),
    ).toEqual(['$.myRead: {opt:9} names no option "9" in call a']);
    expect(
      problems((s) => {
        (s.calls[1] as Call).why = "Choose {opt:3}.";
      }),
    ).toEqual(['$.calls[1].why: {opt:3} names no option "3" in call b']);
    expect(
      problems((s) => {
        s.interplay = [{ from: "a", to: "b", text: "Needs {call:a,opt:7}." }];
      }),
    ).toEqual([
      '$.interplay[0].text: {call:a,opt:7} names no option "7" in call a',
    ]);
  });

  it("rejects a call that does not exist", () => {
    expect(
      problems((s) => {
        s.myRead = "Ask {call:z}.";
      }),
    ).toEqual(['$.myRead: {call:z} names no call "z"']);
  });

  it("rejects an option token outside any call when the source has several calls", () => {
    const [problem] = problems((s) => {
      s.myRead = "Choose {opt:1}.";
    });
    expect(problem).toContain(
      "$.myRead: {opt:1} is ambiguous with several calls",
    );
    // Inside a call the same token means that call's option.
    expect(
      problems((s) => {
        (s.calls[1] as Call).why = "Choose {opt:1}.";
      }),
    ).toEqual([]);
  });

  it("rejects a token that is malformed, so a typo never reads as literal text", () => {
    for (const bad of [
      "{opt:}",
      "{opt:3",
      "{call:}",
      "{opt: 3}",
      "{opt:3,call:a}",
      "{call:a,opt:}",
      "{opt:a b}",
      "{option:1}",
      "{Opt:1}",
      "{ opt:1}",
      "{call :a}",
    ])
      expect(
        problems((s) => {
          s.myRead = `Choose ${bad} now.`;
        }, pilotJson),
      ).toEqual([
        expect.stringContaining("$.myRead: malformed reference token"),
      ]);
  });

  it("rejects a token in a field that is an id, a title, a name or a citation", () => {
    const where = (mutate: (s: DecisionSource) => void) =>
      problems(mutate, pilotJson).map((p) => p.split(":")[0]);
    expect(where((s) => (s.title = "Pick {opt:1}"))).toEqual(["$.title"]);
    expect(
      where((s) => {
        (s.calls[0] as Call).options[0]!.name = "Pick {opt:1}";
      }),
    ).toEqual(["$.calls[0].options[0].name"]);
    expect(
      where((s) => {
        s.currentBehaviour[0]!.source = "AGENTS.md {opt:1}";
      }),
    ).toEqual(["$.currentBehaviour[0].source"]);
    expect(
      where((s) => {
        (s.glossary ?? [])[0]!.term = "{opt:1}";
      }),
    ).toEqual(["$.glossary[0].term"]);
  });

  it("rejects a token in the priority, the reversibility and a glossary meaning, which the sheet shows as plain text", () => {
    const where = (mutate: (s: DecisionSource) => void) =>
      problems(mutate, pilotJson).map((p) => p.split(":")[0]);
    expect(where((s) => (s.priority = "High, see {opt:1}"))).toEqual([
      "$.priority",
    ]);
    expect(where((s) => (s.reversibility = "Hard after {opt:2}"))).toEqual([
      "$.reversibility",
    ]);
    expect(
      where((s) => {
        (s.glossary ?? [])[0]!.meaning = "Means {opt:3}";
      }),
    ).toEqual(["$.glossary[0].meaning"]);
  });

  it("accepts a token under an option id that is also the name of a field", () => {
    const source = pilotJson();
    const call = source.calls[0] as Call;
    call.options[0]!.id = "name";
    const sub = call.subQuestions?.[0];
    if (!sub) throw new Error("fixture lost its sub-question");
    delete sub.byOption["1"];
    // The answer sits under the key `name`, which is also a field that takes no token.
    sub.byOption.name = "Same as {opt:2}.";
    expect(() => parseSource(source)).not.toThrow();
    // A token still has to name an option that exists.
    sub.byOption.name = "Same as {opt:nope}.";
    expect(() => parseSource(source)).toThrow(/names no option "nope"/);
  });

  it("rejects a call token in a source with one call, where no call section exists to link to", () => {
    expect(
      problems((s) => {
        s.myRead = "See {call:a}.";
      }, pilotJson),
    ).toEqual([
      "$.myRead: {call:a} has no target in a source with one call; name an option with {opt:N}",
    ]);
    expect(
      problems((s) => {
        s.myRead = "See {call:a,opt:2}.";
      }, pilotJson),
    ).toEqual([]);
  });

  it("leaves braces that are not a token alone", () => {
    expect(
      problems((s) => {
        s.myRead = "Use the {placeholder} syntax and a set {1, 2}.";
      }, pilotJson),
    ).toEqual([]);
  });

  it("does not check a token against a source that is already invalid", () => {
    const bad = twoCalls();
    (bad.calls[1] as Call).options = [];
    bad.myRead = "Choose {opt:99}.";
    const found = problems(
      () => {},
      () => bad,
    );
    expect(found.some((p) => p.includes("options"))).toBe(true);
    expect(found.some((p) => p.includes("{opt:99}"))).toBe(false);
  });

  it("reports the same problems from refProblems alone", () => {
    const source = twoCalls();
    source.myRead = "Choose {opt:1}.";
    expect(refProblems(source).map((p) => p.path)).toEqual(["$.myRead"]);
  });
});

describe("reference tokens: plain words in every projection", () => {
  it("writes each token form as plain words", () => {
    expect(refWords({ opt: "3" })).toBe(`${LABEL.refOption} 3`);
    expect(refWords({ call: "c" })).toBe("(c)");
    expect(refWords({ call: "c", opt: "1" })).toBe(`(c) ${LABEL.refOption} 1`);
    expect(plainText("Choose {opt:4}, not {call:a,opt:2}. See {call:b}.")).toBe(
      "Choose option 4, not (a) option 2. See (b).",
    );
    expect(splitRefs("a {opt:1} b")).toStrictEqual([
      { kind: "text", text: "a " },
      { kind: "ref", opt: "1" },
      { kind: "text", text: " b" },
    ]);
  });

  it("shows no brace in the markdown, the comment or the compact sheet", () => {
    const source = parseSource(pilotWithRefs());
    const md = renderElaboration(source);
    expect(md).toContain(
      "If they are few, choose option 4. If they are many, choose option 3. Do not keep option 1 or option 2",
    );
    for (const out of [
      md,
      renderComment(source),
      renderHtml(source, "compact"),
    ])
      expect(out.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(
        /\{(opt|call):/,
      );
  });

  it("keeps the token in the embedded source, so a regenerated sheet is the same source", () => {
    const source = pilotWithRefs();
    for (const template of ["compact", "document"] as const)
      expect(extractSource(renderHtml(parseSource(source), template))).toEqual(
        source,
      );
  });

  it("plainSource writes tokens out and changes nothing else", () => {
    const source = parseSource(pilotWithRefs());
    const plain = plainSource(source);
    expect(plain.myRead).toBe(plainText(source.myRead));
    expect({ ...plain, myRead: "" }).toEqual({ ...source, myRead: "" });
  });
});

describe("reference tokens: links on the document sheet", () => {
  it("turns each token into a link that traces its option or call, with its words as the text", () => {
    const html = renderHtml(parseSource(twoCalls()), "document");
    // A call-level token and a decision-level token with its call named.
    expect(html).toContain(
      '<a class="ref" href="#o-a-3" data-t="o-a-3">(a) option 3</a>',
    );
    const single = renderHtml(parseSource(pilotWithRefs()), "document");
    for (const n of ["1", "2", "3", "4"])
      expect(single).toContain(
        `<a class="ref" href="#o-a-${n}" data-t="o-a-${n}">option ${n}</a>`,
      );
  });

  it("links a call token to its call section", () => {
    const source = twoCalls();
    (source.calls[0] as Call).notes = ["The queue is call {call:b}."];
    const html = renderHtml(parseSource(source), "document");
    expect(html).toContain(
      '<a class="ref" href="#call-b" data-t="c-b">(b)</a>',
    );
    // Every link target exists on the page.
    for (const m of html.matchAll(/class="ref" href="#([^"]+)"/g))
      expect(html).toContain(`id="${m[1]}"`);
  });

  it('links nothing by pattern: "keep 1 year" and a statute citation stay plain text', () => {
    const source = twoCalls();
    (source.calls[0] as Call).notes = [
      "Keep 1 year of logs. The statute says so in article 5(b) and in a2.",
    ];
    source.myRead = "Choose option 1 or (b) or b2 as written.";
    const html = renderHtml(parseSource(source), "document");
    expect(html).toContain(
      "Keep 1 year of logs. The statute says so in article 5(b) and in a2.",
    );
    expect(html).toContain("Choose option 1 or (b) or b2 as written.");
    // The one token is the interplay line, which shows in the interplay list and under "Connects to" of each call.
    const refs = [...html.matchAll(/class="ref" href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(refs).toEqual(["#o-a-3", "#o-a-3", "#o-a-3"]);
  });

  it("links an issue id by its own pattern, from the decision URL", () => {
    const html = renderHtml(parseSource(pilotJson()), "document");
    expect(html).toContain(
      '<a class="ref-x" href="https://tracker.example.com/acme/issue/ENG-198">ENG-198</a>',
    );
    const source = pilotJson();
    source.url = "https://example.test/decisions/210";
    expect(renderHtml(parseSource(source), "document")).not.toContain(
      'class="ref-x"',
    );
  });
});

describe("document template: structure and states", () => {
  it("stays within the size budget, with the embedded source and its script", () => {
    const size = Buffer.byteLength(
      renderHtml(parseSource(pilotWithRefs()), "document"),
    );
    expect(size).toBeGreaterThan(30 * 1024);
    expect(size).toBeLessThanOrEqual(60 * 1024);
  });

  it("puts the question, the recommendation and the matrix before the options, in that order", () => {
    const html = renderHtml(parseSource(pilotJson()), "document");
    const order = [
      'id="question"',
      'id="outcomes"',
      'id="before"',
      'id="options"',
      'id="now"',
      'id="terms"',
    ].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The recommendation sits beside the question: inside the same section.
    const question = html.slice(
      html.indexOf('id="question"'),
      html.indexOf('id="outcomes"'),
    );
    expect(question).toContain(`<h3 class="lab">${LABEL.recommendation}</h3>`);
  });

  it("reshapes a ruled call: the ruling replaces the recommendation, the other rows go quiet", () => {
    const source = pilotJson();
    (source.calls[0] as Call).ruling = {
      option: "3",
      recordUrl: "https://tracker.example.com/acme/issue/ENG-210#comment-9",
      ruledAt: "2026-10-04",
    };
    const html = renderHtml(parseSource(source), "document");
    expect(html).toContain(`<h3 class="lab">${LABEL.ruling}</h3>`);
    expect(html).not.toContain(`<h3 class="lab">${LABEL.recommendation}</h3>`);
    expect(html).toContain(
      `<span class="tag tag-chosen">${LABEL.chosen}</span>`,
    );
    const matrix = html.slice(
      html.indexOf('<table class="mx">'),
      html.indexOf("</table>", html.indexOf('<table class="mx">')),
    );
    expect(matrix.match(/<tr data-t="o-a-\d" class="dim">/g)).toHaveLength(3);
    expect(html.match(/<article class="opt dim"/g)).toHaveLength(3);
    // A ruled call has no Pick control, and no column for it.
    expect(html).not.toContain('class="pick');
    expect(html).not.toContain(`>${DOCUMENT_LABEL.pick}<`);
    // The hidden branches move after the options once every call is ruled.
    expect(html.indexOf('id="before"')).toBeGreaterThan(
      html.indexOf('id="options"'),
    );
  });

  it("gives only the open calls of a partly ruled source a Pick control", () => {
    const source = twoCalls();
    (source.calls[1] as Call).ruling = {
      option: "2",
      recordUrl: "https://x.test/r",
      ruledAt: "2026-10-04",
    };
    const html = renderHtml(parseSource(source), "document");
    expect(html).toContain('class="pick pick-dot" data-call="a"');
    expect(html).not.toContain('data-call="b"');
    expect(html).not.toContain('data-pick-long="b"');
  });

  it("hides each control that needs a script until the script shows it", () => {
    const html = renderHtml(parseSource(pilotJson()), "document");
    for (const m of html.matchAll(/<button type="button" class="pick[^>]*>/g))
      expect(m[0]).toContain(" hidden");
    for (const m of html.matchAll(/<[a-z]+ [^>]*data-js[^>]*>/g))
      expect(m[0]).toContain(" hidden");
  });

  it("links the first use of a glossary term in each region to its meaning, with a described tooltip", () => {
    const html = renderHtml(parseSource(pilotJson()), "document");
    const question = html.slice(
      html.indexOf('id="question"'),
      html.indexOf('id="outcomes"'),
    );
    expect(
      question.match(/class="term" href="#t-supplier-feed"/g),
    ).toHaveLength(1);
    for (const m of html.matchAll(
      /class="term" href="#([^"]+)" aria-describedby="([^"]+)"/g,
    )) {
      expect(html).toContain(`id="${m[1]}"`);
      expect(html).toContain(`<span class="tip" role="tooltip" id="${m[2]}">`);
    }
    // Every tip id is unique, and so is every anchor id.
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks a glossary term whose first character is a regular-expression metacharacter", () => {
    const source = pilotJson();
    source.glossary = [
      { term: "[Hold]", meaning: "Put aside." },
      { term: "^Caret", meaning: "A caret." },
      { term: "\\Slash", meaning: "A slash." },
      { term: "(Release)", meaning: "Give back." },
    ];
    source.question =
      "The [Hold] list, the ^Caret rule, the \\Slash and the (Release) term.";
    const html = renderHtml(parseSource(source), "document");
    const question = html.slice(
      html.indexOf('id="question"'),
      html.indexOf('id="outcomes"'),
    );
    expect(question.match(/class="term"/g)).toHaveLength(4);
    // Anchor ids stay unique and usable.
    for (const m of html.matchAll(/class="term" href="#([^"]+)"/g))
      expect(html).toContain(`<dt id="${m[1]}">`);
  });

  it("shows the owners of a several-call sheet as traceable, and only there", () => {
    expect(renderHtml(parseSource(twoCalls()), "document")).toContain(
      'class="own" tabindex="0" data-t="w-technical"',
    );
    expect(renderHtml(parseSource(pilotJson()), "document")).not.toContain(
      'tabindex="0" data-t="w-',
    );
  });

  it("writes the status in the title block as a glyph and a word", () => {
    const open = renderHtml(parseSource(pilotJson()), "document");
    expect(open).toContain(
      `<span class="st st-open">${DOCUMENT_LABEL.stateOpen} Open: needs a human call</span>`,
    );
    const part = twoCalls();
    (part.calls[1] as Call).ruling = {
      option: "1",
      recordUrl: "https://x.test/r",
      ruledAt: "2026-10-04",
    };
    expect(renderHtml(parseSource(part), "document")).toContain(
      `<span class="st st-part">${DOCUMENT_LABEL.statePart} Partly decided: 1 of 2 calls ruled</span>`,
    );
  });

  it("renders the seven-call source and the edge cases without an empty region", () => {
    for (const name of ["multicall.json", "edge-cases.json"]) {
      const source = parseSource(fixture(name));
      const html = renderHtml(source, "document");
      expect(html.match(/<section class="call/g)).toHaveLength(
        source.calls.length,
      );
      expect(html).not.toContain('<div class="body"></div>');
      expect(html).not.toContain("<ul></ul>");
      expect(html).not.toContain('<table class="mx"><thead><tr></tr>');
      expect(nodes(html).length).toBeGreaterThan(200);
    }
  });

  it("renders a five-option, four-scenario matrix and a call without a matrix", () => {
    const source = parseSource(fixture("edge-cases.json"));
    const html = renderHtml(source, "document");
    const a = html.slice(
      html.indexOf('id="call-a"'),
      html.indexOf('id="call-b"'),
    );
    const b = html.slice(html.indexOf('id="call-b"'));
    expect(a.match(/<td class="k-[a-z]+" data-s=/g)).toHaveLength(20);
    expect(b).not.toContain('<table class="mx">');
    // Without scenarios there is no legend, and the options still render.
    expect(b).not.toContain('class="legend"');
    expect(b).toContain('class="opts"');
  });

  it("adds a Pick column to the matrix of an open call only", () => {
    const html = renderHtml(parseSource(pilotJson()), "document");
    expect(html.match(/<td class="mx-p" data-js hidden>/g)).toHaveLength(4);
    expect(html).toContain(
      `<th class="mx-p" scope="col" data-js hidden>${DOCUMENT_LABEL.pick}</th>`,
    );
  });
});

describe("the --template flag and the template of a posted sheet", () => {
  const run = (args: string[], cwd = REPO_ROOT) =>
    spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  const render = (template?: string) => {
    const out = mkdtempSync(join(tmpdir(), "decision-sheet-template-"));
    const r = run([
      "render",
      join(FIXTURES, "pilot.json"),
      "--out",
      out,
      ...(template ? ["--template", template] : []),
    ]);
    return { r, out, file: join(out, "ENG-210-decision-sheet.html") };
  };

  it("renders the document template by default and says so", () => {
    const { r, file } = render();
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).template).toBe("document");
    expect(extractTemplate(readFileSync(file, "utf8"))).toBe("document");
  });

  it("renders the compact template on request, byte-for-byte as before", () => {
    const { r, file } = render("compact");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).template).toBe("compact");
    expect(readFileSync(file, "utf8")).toBe(
      readFileSync(join(FIXTURES, "pilot.compact.html.txt"), "utf8"),
    );
  });

  it("rejects an unknown template and writes nothing", () => {
    const { r, out } = render("poster");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "--template takes compact or document; not: poster",
    );
    expect(
      spawnSync("ls", [join(out, "ENG-210-decision-sheet.html")]).status,
    ).not.toBe(0);
  });

  it("prints the template of a posted sheet, so a regenerated sheet keeps it", () => {
    for (const template of ["compact", "document"])
      expect(run(["template", render(template).file]).stdout.trim()).toBe(
        template,
      );
  });

  it("reads a sheet made before the template existed as compact", () => {
    const file = join(FIXTURES, "pilot.sheet.html.txt");
    // The pilot sheet has no embedded source at all, so it has no template to read.
    expect(run(["template", file]).status).not.toBe(0);
    expect(
      extractTemplate(
        readFileSync(join(FIXTURES, "pilot.compact.html.txt"), "utf8"),
      ),
    ).toBe("compact");
  });

  it("refuses a sheet with a template it does not know", () => {
    const { file } = render("document");
    const html = readFileSync(file, "utf8").replace(
      'data-template="document"',
      'data-template="poster"',
    );
    expect(() => extractTemplate(html)).toThrow(/unknown template "poster"/);
  });

  it("regenerates a ruled sheet in the template it was posted in, from its own embedded source", () => {
    for (const template of ["compact", "document"] as const) {
      const posted = renderHtml(parseSource(pilotJson()), template);
      const source = extractSource(posted) as DecisionSource;
      (source.calls[0] as Call).ruling = {
        option: "3",
        recordUrl: "https://tracker.example.com/acme/issue/ENG-210#comment-9",
        ruledAt: "2026-10-04",
      };
      const again = renderHtml(parseSource(source), extractTemplate(posted));
      expect(extractTemplate(again)).toBe(template);
      expect(again).toContain("Ruling record");
    }
  });
});

describe("colours of the document template", () => {
  /** An sRGB hex colour or an `oklch(L C H)` colour as linear sRGB, clamped to the gamut. */
  function linear(colour: string): [number, number, number] {
    const hex = /^#([0-9a-f]{6})$/i.exec(colour);
    if (hex) {
      const lin = (c: number) =>
        c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      const n = Number.parseInt(hex[1] as string, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
        lin(v / 255),
      ) as [number, number, number];
    }
    const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(colour);
    if (!m) throw new Error(`cannot read colour ${colour}`);
    const [L, C, h] = [
      Number(m[1]),
      Number(m[2]),
      (Number(m[3]) * Math.PI) / 180,
    ];
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return [
      clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
      clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
      clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
    ];
  }
  const luminance = (colour: string) => {
    const [r, g, b] = linear(colour);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (fg: string, bg: string) => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [
      number,
      number,
    ];
    return (hi + 0.05) / (lo + 0.05);
  };

  it("reads an oklch colour the way a browser does (a known pair)", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(luminance("oklch(1 0 0)")).toBeCloseTo(1, 2);
    expect(luminance("oklch(0 0 0)")).toBeCloseTo(0, 2);
  });

  it("every palette text on its background meets WCAG AA, tinted tiles included", () => {
    // The list must not shrink to nothing, or an empty check would pass.
    expect(TEXT_PAIRS.length).toBeGreaterThan(15);
    const failing = TEXT_PAIRS.filter(([fg, bg]) => contrast(fg, bg) < 4.5).map(
      ([fg, bg, where]) =>
        `${where}: ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}`,
    );
    expect(failing).toEqual([]);
  });

  // What the stylesheet applies in each state (a later override, pressed, hover,
  // the tray) is measured from computed styles in `decision-sheet-browser.test.ts`;
  // TEXT_PAIRS above is only the list of palette constants.

  it("draws the outcome inks dark enough for their tints, where a mid-lightness step of the same hue fails", () => {
    expect(
      contrast(OUTCOME_INK.emerald, TOKEN_TINTS.emeraldLight),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(OUTCOME_INK.amber, TOKEN_TINTS.amberLight),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast("oklch(0.55 0.11 150)", TOKEN_TINTS.emeraldLight),
    ).toBeLessThan(4.5);
    expect(contrast("oklch(0.66 0.1 70)", TOKEN_TINTS.amberLight)).toBeLessThan(
      4.5,
    );
  });

  it("keeps the compact outcome colours readable on the surface, and the highlight row an oklch colour", () => {
    expect(
      Object.values(OUTCOME_COLOUR).every(
        (c) => contrast(c, PALETTE.surface) >= 4.5,
      ),
    ).toBe(true);
    expect(HIGHLIGHT_ROW).toMatch(/^oklch\(/);
  });
});

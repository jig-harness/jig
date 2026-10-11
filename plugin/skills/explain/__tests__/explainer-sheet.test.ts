/**
 * Unit tests of the explainer sheet: the source validator, the escaping of
 * every text field, absent optional fields, a citation for every claim,
 * "no claim absent from the source", step tokens, the figure checks, the
 * markdown projection and the CLI.
 *
 * The fixture is a full-size explainer of a fictional online shop: how an
 * order's checkout works today, with a flow, sections of cited claims, open
 * questions, terms, related links and one figure. The figure is the built
 * `checkout-flow.figure.svg` next to the diagram source it was built from,
 * so the figure's provenance hash holds.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Window } from "happy-dom";
import { gitIdentityEnv } from "../../drive-pr/scripts/lib/proc.ts";
import { loadFigures } from "../scripts/explainer-sheet/explainer-sheet.ts";
import {
  figureFile,
  figureProblems,
  sha256,
} from "../scripts/explainer-sheet/figures.ts";
import { renderExplainerHtml } from "../scripts/explainer-sheet/html.ts";
import {
  LABEL,
  SHEET_FILENAME_SUFFIX,
  SHEET_LABEL,
} from "../scripts/explainer-sheet/labels.ts";
import { renderMarkdown } from "../scripts/explainer-sheet/markdown.ts";
import {
  citations,
  type ExplainerSource,
  parseSource,
  plainText,
  SourceError,
} from "../scripts/explainer-sheet/source.ts";

const FIXTURES = join(import.meta.dir, "fixtures/explainer-sheet");
const SCRIPT = resolve(
  import.meta.dir,
  "../scripts/explainer-sheet/explainer-sheet.ts",
);
const read = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const real = (): ExplainerSource => JSON.parse(read("order-checkout.json"));
const FIGURE_SVG = read("checkout-flow.figure.svg.txt");
const DIAGRAM_SHA = sha256(read("checkout-flow.workflow.json"));
const figures = () => new Map([["checkout-flow", FIGURE_SVG.trim()]]);

/** The smallest valid source: every optional field absent. */
const minimal = (): ExplainerSource => ({
  schema: "explainer-sheet/v1",
  id: "minimal",
  title: "A minimal explainer",
  verifiedAt: { date: "2026-10-04", commit: "abcdef1" },
  summary: "One paragraph.",
  scope: { covers: ["One thing"] },
  sections: [
    {
      id: "only",
      title: "Only section",
      claims: [{ text: "One claim.", source: "README.md" }],
    },
  ],
});

function problems(value: unknown): string[] {
  try {
    parseSource(value);
    return [];
  } catch (err) {
    if (err instanceof SourceError) return err.problems;
    throw err;
  }
}

/** Every string leaf of a value, with its JSON path. */
function leaves(value: unknown, path = "$"): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value))
    return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  return [];
}

function setAt(root: unknown, path: string, value: string): void {
  const keys = [...path.slice(1).matchAll(/\.([^.[]+)|\[(\d+)\]/g)].map(
    (m) => m[1] ?? Number(m[2]),
  );
  let at = root as Record<string | number, unknown>;
  for (const k of keys.slice(0, -1))
    at = at[k as string] as Record<string | number, unknown>;
  at[keys[keys.length - 1] as string] = value;
}

/**
 * happy-dom's HTML parser loses the rest of the page after a `<style>` inside
 * inline SVG (Chrome does not; the browser suite renders the real page). The
 * figure's own words are not checked here anyway, so structural checks parse
 * the page without its figures.
 */
const withoutFigures = (html: string) =>
  html.replace(/<svg[\s\S]*?<\/svg>/g, "");

const textOf = (html: string) => {
  const w = new Window();
  w.document.write(withoutFigures(html));
  for (const el of w.document.querySelectorAll("script,style,svg")) el.remove();
  // Text nodes joined with a space: adjacent elements must not glue two words into one.
  const parts: string[] = [];
  const walk = (n: { childNodes: ArrayLike<unknown> }) => {
    for (const c of Array.from(n.childNodes) as {
      nodeType: number;
      textContent: string | null;
      childNodes: ArrayLike<unknown>;
    }[])
      if (c.nodeType === 3) parts.push(c.textContent ?? "");
      else walk(c);
  };
  walk(w.document.body);
  w.close();
  return parts.join(" ");
};

describe("the real explainer", () => {
  it("validates, cites every step and claim, and renders with its figure", () => {
    const source = parseSource(real());
    expect(source.flow?.length).toBeGreaterThanOrEqual(2);
    expect(source.sections.length).toBeGreaterThanOrEqual(1);
    const html = renderExplainerHtml(source, figures());
    expect(html).toContain("<svg ");
    expect(html).toContain('id="fig-checkout-flow"');
  });

  it("its built figure passes the embed check against its own diagram source", () => {
    expect(figureProblems(FIGURE_SVG, "checkout-flow", DIAGRAM_SHA)).toEqual(
      [],
    );
  });
});

describe("source validation", () => {
  it("accepts the minimal source", () => {
    expect(problems(minimal())).toEqual([]);
  });

  it("rejects an unknown key, so a typo never drops text silently", () => {
    expect(problems({ ...minimal(), sumary: "x" })).toContain(
      "$.sumary: unknown field",
    );
  });

  it("rejects a claim or a step with no citation", () => {
    const s = minimal() as unknown as {
      sections: { claims: Record<string, unknown>[] }[];
    };
    delete s.sections[0]?.claims[0]?.source;
    expect(problems(s)).toContain(
      "$.sections[0].claims[0].source: is required",
    );
    const f = {
      ...minimal(),
      flow: [
        { id: "1", title: "a", text: "b" },
        { id: "2", title: "c", text: "d", source: "x.ts" },
      ],
    };
    expect(problems(f)).toContain("$.flow[0].source: is required");
  });

  it("rejects empty text, a section with no claim, and duplicate ids", () => {
    expect(problems({ ...minimal(), summary: " " })).toContain(
      "$.summary: must be a non-empty string",
    );
    expect(
      problems({
        ...minimal(),
        sections: [{ id: "a", title: "A", claims: [] }],
      }),
    ).toContain("$.sections[0].claims: needs at least 1 item(s)");
    const s = minimal();
    s.sections.push({ ...(s.sections[0] as ExplainerSource["sections"][0]) });
    expect(problems(s)).toContain("$.sections: has a duplicate id");
  });

  it("rejects an id, a figure diagram and a URL of the wrong shape", () => {
    expect(problems({ ...minimal(), id: "Not Kebab" })).toContain(
      "$.id: must be kebab-case, such as order-checkout",
    );
    expect(problems({ ...minimal(), url: "http://example.com" })[0]).toMatch(
      /^\$\.url: must be an https URL/,
    );
    const fig = (diagram: string) => ({
      ...minimal(),
      figures: [{ id: "f", title: "T", caption: "C", diagram }],
    });
    expect(problems(fig("docs/diagrams/archify/x.workflow.json"))).toEqual([]);
    for (const bad of [
      "x.workflow.json",
      "docs/../x.workflow.json",
      "docs/x.pdf",
      "docs/x.unknown.json",
    ])
      expect(problems(fig(bad)).join()).toContain("$.figures[0].diagram");
  });

  it("accepts every documented citation form", () => {
    const s = minimal();
    (s.sections[0] as { claims: { source: string }[] }).claims[0]!.source =
      "apps/web/src/a.ts#fn; apps/web/src/b.ts:12-40; apps/web/Dockerfile; docs/adr/; .gitignore; README.md; ADR-0017; ENG-123; db/schema.sql (check_rule_link)";
    expect(() => parseSource(s)).not.toThrow();
  });

  it("accepts a backtick-quoted path with a space, and refuses a space outside backticks", () => {
    const cite = (source: string) => {
      const s = minimal();
      (s.sections[0] as { claims: { source: string }[] }).claims[0]!.source =
        source;
      return problems(s);
    };
    expect(cite("`.run/Backend Dev.run.xml`")).toEqual([]);
    expect(cite("`.run/Backend Dev.run.xml` (dev run config)")).toEqual([]);
    expect(cite("`apps/web/a b.ts#fn`; README.md")).toEqual([]);
    expect(cite(".run/Backend Dev.run.xml").join()).toContain(
      "is not a repository path",
    );
  });

  it("hands the freshness guard the cited reference, never its display note", () => {
    const s = minimal();
    (s.sections[0] as { claims: { source: string }[] }).claims[0]!.source =
      "README.md (Node.js); `.run/Backend Dev.run.xml` (dev run); ADR-0017";
    expect(citations(parseSource(s))).toEqual([
      "README.md",
      "`.run/Backend Dev.run.xml`",
      "ADR-0017",
    ]);
  });

  it.each([
    "trust me",
    "x",
    "apps/web/a.ts and more",
    "apps/web/a.ts;",
    "apps/web/a.ts; trust me",
    "apps/web/a.ts#",
    "ADR-1",
    "v1.2",
  ])("rejects the unparseable citation %j, in a claim and in a step", (bad) => {
    const claim = minimal();
    (claim.sections[0] as { claims: { source: string }[] }).claims[0]!.source =
      bad;
    expect(problems(claim).join()).toContain("$.sections[0].claims[0].source:");
    const step = {
      ...minimal(),
      flow: [
        { id: "1", title: "a", text: "b", source: bad },
        { id: "2", title: "c", text: "d", source: "x.ts" },
      ],
    };
    expect(problems(step).join()).toContain("$.flow[0].source:");
  });

  it("needs at least two flow steps when a flow is given", () => {
    expect(
      problems({
        ...minimal(),
        flow: [{ id: "1", title: "a", text: "b", source: "x.ts" }],
      }),
    ).toContain("$.flow: needs at least 2 item(s)");
  });
});

describe("step tokens", () => {
  const withFlow = (): ExplainerSource => ({
    ...minimal(),
    flow: [
      { id: "1", title: "First", text: "Starts here.", source: "a.ts" },
      { id: "2", title: "Second", text: "After {step:1}.", source: "b.ts" },
    ],
  });

  it("render as a link that traces its step, and as plain words in markdown", () => {
    const source = parseSource(withFlow());
    const html = renderExplainerHtml(source);
    expect(html).toContain(
      `<a class="ref" href="#step-1" data-t="s-1">${LABEL.refStep} 1</a>`,
    );
    expect(html).toContain('id="step-1" data-t="s-1"');
    expect(renderMarkdown(source)).toContain(`After ${LABEL.refStep} 1.`);
    expect(renderMarkdown(source)).not.toContain("{");
    expect(textOf(html)).not.toContain("{");
  });

  it("reject a step that does not exist, and a malformed token", () => {
    const s = withFlow();
    (s.sections[0]?.claims[0] as { text: string }).text = "See {step:9}.";
    expect(problems(s)).toContain(
      "$.sections[0].claims[0].text: {step:9} names no flow step",
    );
    s.sections[0] = {
      ...(s.sections[0] as ExplainerSource["sections"][0]),
      claims: [{ text: "See { step : 1 }.", source: "x.ts" }],
    };
    expect(problems(s).join()).toContain("malformed token");
  });

  it("are an error in a field that shows text as is: a title, a citation, a term", () => {
    const s = withFlow();
    (s.flow?.[0] as { title: string }).title = "Before {step:2}";
    expect(problems(s)).toContain(
      "$.flow[0].title: may not hold a {step:N} token",
    );
    const t = { ...withFlow(), terms: [{ term: "X", meaning: "{step:1}" }] };
    expect(problems(t)).toContain(
      "$.terms[0].meaning: may not hold a {step:N} token",
    );
  });
});

describe("escaping", () => {
  const PAYLOAD = `<xq>"&'</xq>`;
  /** Fields the validator constrains to a fixed shape; a payload there is rejected, not rendered. */
  const SHAPED =
    /^\$\.(?:schema|id|url|verifiedAt\.(?:date|commit)|figures\[\d+\]\.(?:id|diagram)|flow\[\d+\]\.(?:id|source)|sections\[\d+\]\.(?:id|claims\[\d+\]\.source)|related\[\d+\]\.url)$/;

  it("escapes every text field of the real source, in the sheet and in the markdown", () => {
    const fields = leaves(real()).filter(([p]) => !SHAPED.test(p));
    expect(fields.length).toBeGreaterThan(100);
    for (const [path] of fields) {
      const s = real();
      setAt(s, path, PAYLOAD);
      const source = parseSource(s);
      const html = renderExplainerHtml(source, figures());
      expect(html.includes("<xq>")).toBe(false);
      expect(html.includes("&lt;xq&gt;&quot;&amp;&#39;&lt;/xq&gt;")).toBe(true);
      // A citation is an inline code span, where markup is literal text.
      expect(renderMarkdown(source).replace(/`[^`\n]*`/g, "")).not.toContain(
        "<xq>",
      );
    }
  });

  it("keeps a multi-line citation in one code span", () => {
    const s = minimal();
    const claim = (s.sections[0] as { claims: { source: string }[] })
      .claims[0] as { source: string };
    claim.source = "docs/a.md#one;\n\ndocs/b.md#two";
    const md = renderMarkdown(parseSource(s));
    expect(md).toContain("`docs/a.md#one; docs/b.md#two`");
    expect(md).not.toMatch(/^docs\/b\.md/m);
  });

  it("keeps the embedded source inert", () => {
    const s = minimal();
    s.summary = "</script><script>alert(1)</script>";
    const html = renderExplainerHtml(parseSource(s));
    expect(html.match(/<script/g)?.length).toBe(2);
  });
});

describe("absent optional fields leave no empty region", () => {
  it("renders the minimal source with no flow, figure, open questions, terms, related or exclusions", () => {
    const html = renderExplainerHtml(parseSource(minimal()));
    for (const id of ["flow", "open", "terms", "related"])
      expect(html).not.toContain(`id="${id}"`);
    expect(html).not.toContain('class="fig"');
    expect(html).not.toContain(LABEL.excludes);
    expect(html).not.toMatch(
      /<(ul|ol)[^>]*><\/\1>|<dl[^>]*><\/dl>|<p[^>]*><\/p>/,
    );
    const md = renderMarkdown(parseSource(minimal()));
    for (const label of [
      LABEL.flow,
      LABEL.openQuestions,
      LABEL.terms,
      LABEL.excludes,
      LABEL.figure,
    ])
      expect(md).not.toContain(label);
  });

  it("refuses to render a figure it was not given, rather than leaving a gap", () => {
    expect(() => renderExplainerHtml(parseSource(real()))).toThrow(
      "figure checkout-flow: no built figure",
    );
  });
});

describe("every claim has a citation", () => {
  it("sets each step and each claim beside its own citation", () => {
    const source = parseSource(real());
    const w = new Window();
    w.document.write(withoutFigures(renderExplainerHtml(source, figures())));
    const items = [...w.document.querySelectorAll(".claims li, .steps li")];
    const expected =
      (source.flow?.length ?? 0) +
      source.sections.reduce((n, s) => n + s.claims.length, 0);
    expect(items.length).toBe(expected);
    const cited = [
      ...(source.flow ?? []).map((s) => s.source),
      ...source.sections.flatMap((s) => s.claims.map((c) => c.source)),
    ];
    items.forEach((li, i) => {
      expect(li.querySelector(".src code")?.textContent).toBe(cited[i]);
    });
    w.close();
  });

  it("gives the freshness guard every citation: steps, claims and figure sources", () => {
    const source = parseSource(real());
    const all = citations(source);
    expect(all).toContain("docs/diagrams/checkout-flow.workflow.json");
    // One reference per `;`-separated segment of every flow step, claim and figure.
    const cited = [
      ...(source.flow ?? []).map((st) => st.source),
      ...source.sections.flatMap((sec) => sec.claims.map((c) => c.source)),
      ...(source.figures ?? []).map((f) => f.diagram),
    ];
    expect(all.length).toBe(
      cited.reduce((n, text) => n + text.split(";").length, 0),
    );
  });
});

describe("no claim absent from the source", () => {
  /**
   * Every word on the sheet and in the markdown is a word of the source (or
   * of a token's plain form), or of the label table. A figure's words come
   * from its cited diagram source, so the SVG is left out here; its caption
   * names that source.
   */
  function strayWords(source: ExplainerSource, text: string): string[] {
    const allowed = new Set<string>();
    const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const [, v] of leaves(source))
      for (const w of [...words(v), ...words(plainText(v))])
        allowed.add(w.toLowerCase());
    for (const v of [
      ...Object.values(LABEL),
      ...Object.values(SHEET_LABEL),
      SHEET_FILENAME_SUFFIX,
    ])
      for (const w of words(v)) allowed.add(w.toLowerCase());
    return [...new Set(words(text))].filter(
      (w) => !allowed.has(w.toLowerCase()),
    );
  }

  it("holds for the real sheet and its markdown", () => {
    const source = parseSource(real());
    expect(
      strayWords(source, textOf(renderExplainerHtml(source, figures()))),
    ).toEqual([]);
    expect(strayWords(source, renderMarkdown(source))).toEqual([]);
  });

  it("catches a word the renderer adds (the check is not vacuous)", () => {
    const source = parseSource(real());
    const html = renderExplainerHtml(source, figures()).replace(
      `>${LABEL.inShort}<`,
      ">Overview<",
    );
    expect(strayWords(source, textOf(html))).toEqual(["Overview"]);
  });
});

describe("figure checks", () => {
  const ok = () => FIGURE_SVG.trim();
  const check = (svg: string) =>
    figureProblems(svg, "checkout-flow", DIAGRAM_SHA);

  it("accepts the built figure and nothing else", () => {
    expect(check(ok())).toEqual([]);
    expect(figureProblems(ok(), "other", DIAGRAM_SHA)).toContain(
      'root <svg> must carry id="fig-other"',
    );
  });

  const ID = "fig-checkout-flow";
  const intoStyle = (rule: string) => (s: string) =>
    s.replace("<style>", `<style>${rule}`);
  const beforeEnd = (markup: string) => (s: string) =>
    s.replace(/<\/svg>$/, `${markup}</svg>`);
  /** Each mutation breaks one clause of the pinned format; the problem names that clause. Problems are matched by prefix. */
  const mutations: [string, (s: string) => string, string][] = [
    [
      "a stale build",
      (s) =>
        s.replace(
          /data-source-sha256="[0-9a-f]+"/,
          `data-source-sha256="${"0".repeat(64)}"`,
        ),
      "was built from another version of its diagram source; rebuild it",
    ],
    ["a script", beforeEnd("<script>x()</script>"), "holds a <script> element"],
    [
      "an event handler",
      (s) => s.replace("<svg ", '<svg onload="x()" '),
      "<svg> carries a onload attribute",
    ],
    [
      "a style attribute",
      beforeEnd('<g style="fill:red"></g>'),
      "<g> carries a style attribute",
    ],
    ["a link", beforeEnd('<a href="https://x">x</a>'), "holds a <a> element"],
    ["a comment", beforeEnd("<!-- x -->"), "markup outside the figure format"],
    // Shapes that slip past a denylist of bad markup: each is outside the grammar.
    [
      "a handler after a slash",
      beforeEnd('<rect class="c-x"/onclick=alert(1)>'),
      "markup outside the figure format",
    ],
    [
      "a handler with no space before it",
      beforeEnd('<rect class="c-x"onclick="x()"/>'),
      "markup outside the figure format",
    ],
    [
      "an entity-encoded url() in an attribute",
      beforeEnd('<g fill="url&#40;https://x&#41;"></g>'),
      "markup outside the figure format",
    ],
    [
      "an image-set() load",
      intoStyle(`#${ID}{background:image-set("https://x" 1x)}`),
      "a declaration loads content outside url()",
    ],
    [
      "a sibling combinator out of the figure",
      intoStyle(`#${ID} ~ main{display:none}`),
      `selector "#${ID} ~ main" is not scoped under #${ID}`,
    ],
    [
      "an attributed second style",
      beforeEnd('<style media="all">body{display:none}</style>'),
      "its <style> carries attributes",
    ],
    [
      "an at-rule",
      intoStyle("@import url(x);"),
      "its <style> holds an at-rule, an escape, an entity or a comment",
    ],
    [
      "an unscoped selector",
      intoStyle(".c-x{fill:red}"),
      `selector ".c-x" is not scoped under #${ID}`,
    ],
    [
      "a second style",
      beforeEnd(`<style>#${ID}{}</style>`),
      "its <style> must be the one first child of the root",
    ],
    [
      "a class with no rule",
      beforeEnd('<g class="brand-new"></g>'),
      "class(es) with no CSS rule: brand-new",
    ],
    [
      "an unprefixed id",
      beforeEnd('<g id="open"></g>'),
      `element id "open" is not prefixed with ${ID}--`,
    ],
    [
      "an id that only shares the stem",
      beforeEnd(`<g id="${ID}-b--x"></g>`),
      `element id "${ID}-b--x" is not prefixed with ${ID}--`,
    ],
    [
      "a url() outside the figure",
      beforeEnd('<g fill="url(#other)"></g>'),
      "url(#other) points outside the figure",
    ],
    [
      "content after the root",
      (s) => `${s}<p>x</p>`,
      "holds content after the root </svg>",
    ],
  ];
  mutations.push(
    [
      "a CSS-escaped url() in a presentation value",
      beforeEnd('<rect fill="u\\72l(https://example.com/paint.svg#p)"/>'),
      "<rect> fill holds a backslash",
    ],
    [
      "a class covered only by an ancestor part of a selector",
      (s) =>
        intoStyle(`#${ID} .brand-new .missing{fill:white}`)(
          beforeEnd('<rect class="brand-new" width="10" height="10"/>')(s),
        ),
      "class(es) with no CSS rule: brand-new",
    ],
    [
      "a class whose only rule needs an attribute the element lacks",
      (s) =>
        intoStyle(`#${ID} .brand-new[data-never]{fill:white}`)(
          beforeEnd('<rect class="brand-new" width="10" height="10"/>')(s),
        ),
      "class(es) with no CSS rule: brand-new",
    ],
    [
      "an upper-case URL() in a rule",
      intoStyle(`#${ID}{fill:URL(https://x/p.png)}`),
      "url(https://x/p.png) points outside the figure",
    ],
    [
      "an upper-case URL() in an attribute",
      beforeEnd('<g fill="URL(https://x/p.svg#g)"></g>'),
      "url(https://x/p.svg#g) points outside the figure",
    ],
    [
      "a rule that lifts the figure over the sheet",
      intoStyle(`#${ID}{position:fixed}`),
      "a rule sets position",
    ],
    [
      "a rule that loads a background",
      intoStyle(`#${ID}{background:red}`),
      "a rule sets background",
    ],
  );
  for (const [what, mutate, problem] of mutations)
    it(`refuses ${what}`, () => {
      const svg = mutate(ok());
      expect(svg).not.toBe(ok());
      const found = check(svg);
      expect(found.some((p) => p.startsWith(problem))).toBe(true);
    });

  const withRule = (rule: string, markup: string) => (s: string) =>
    intoStyle(rule)(beforeEnd(markup)(s));
  const bare = (svg: string) =>
    check(svg).filter((p) => p.startsWith("class(es) with no CSS rule"));

  it("credits only the classes a matched selector names, not every class of the element", () => {
    const svg = withRule(
      `#${ID} text{font-family:serif}`,
      '<text class="t-primary brand-new" x="1" y="1">x</text>',
    )(ok());
    expect(bare(svg)).toEqual(["class(es) with no CSS rule: brand-new"]);
  });

  it("matches the whole selector: ancestors must exist, and a child combinator needs a parent", () => {
    const rect = '<rect class="brand-new" width="10" height="10"/>';
    const missing = withRule(
      `#${ID} .missing-parent .brand-new{fill:white}`,
      rect,
    )(ok());
    expect(bare(missing)).toEqual(["class(es) with no CSS rule: brand-new"]);
    const present = withRule(
      `#${ID} .c-backend .brand-new{fill:white}`,
      `<g class="c-backend">${rect}</g>`,
    )(ok());
    expect(check(present)).toEqual([]);
    const nested = withRule(
      `#${ID} .c-backend > .brand-new{fill:white}`,
      `<g class="c-backend"><g>${rect}</g></g>`,
    )(ok());
    expect(bare(nested)).toEqual(["class(es) with no CSS rule: brand-new"]);
    const direct = withRule(
      `#${ID} .c-backend > .brand-new{fill:white}`,
      `<g class="c-backend">${rect}</g>`,
    )(ok());
    expect(check(direct)).toEqual([]);
    const dangling = withRule(
      `#${ID} .c-backend >{fill:white}`,
      `<g class="c-backend">${rect}</g>`,
    )(ok());
    expect(bare(dangling)).toEqual(["class(es) with no CSS rule: brand-new"]);
  });

  it("refuses the viewer controls a static figure cannot operate", () => {
    const found = check(
      beforeEnd(
        '<rect role="button" tabindex="0" aria-pressed="false" width="1" height="1"/>',
      )(ok()),
    );
    expect(found).toContain("<rect> carries a tabindex attribute");
    expect(found).toContain("<rect> carries a aria-pressed attribute");
    expect(found).toContain(
      '<rect> carries role="button"; only img is allowed',
    );
  });

  /**
   * A repository root holding the fixture's diagram source and no built
   * figure. The suite preload points GROUNDWORK_OVERLAY at another
   * repository's configuration, so it is unset here: these checks read the
   * temporary root's own `.config/groundwork-overlay.yaml`, or none.
   */
  function figureRoot(): { root: string; diagram: string } {
    const root = mkdtempSync(join(tmpdir(), "explainer-figures-"));
    const diagram = "docs/diagrams/checkout-flow.workflow.json";
    mkdirSync(join(root, "docs/diagrams"), { recursive: true });
    writeFileSync(join(root, diagram), read("checkout-flow.workflow.json"));
    return { root, diagram };
  }
  const withoutOverlayOverride = (check: () => void) => {
    const saved = process.env.GROUNDWORK_OVERLAY;
    delete process.env.GROUNDWORK_OVERLAY;
    try {
      check();
    } finally {
      if (saved === undefined) delete process.env.GROUNDWORK_OVERLAY;
      else process.env.GROUNDWORK_OVERLAY = saved;
    }
  };

  it("the CLI refuses a figure that is not built, and one built from another source", () =>
    withoutOverlayOverride(() => {
      const { root, diagram } = figureRoot();
      const source = parseSource(real());
      expect(() => loadFigures(source, root)).toThrow(
        "figure checkout-flow: docs/diagrams/checkout-flow.figure.svg is not built; build it with the repository's figure build (set explain.figure_build_command)",
      );
      writeFileSync(join(root, figureFile(diagram)), FIGURE_SVG);
      expect(loadFigures(source, root).get("checkout-flow")).toBe(
        FIGURE_SVG.trim(),
      );
      writeFileSync(
        join(root, diagram),
        `${read("checkout-flow.workflow.json")} `,
      );
      expect(() => loadFigures(source, root)).toThrow("rebuild it");
    }));

  it("names the configured figure build command for a figure that is not built", () =>
    withoutOverlayOverride(() => {
      const { root } = figureRoot();
      mkdirSync(join(root, ".config"));
      writeFileSync(
        join(root, ".config/groundwork-overlay.yaml"),
        "explain:\n  figure_build_command: scripts/build-figure.sh\n",
      );
      expect(() => loadFigures(parseSource(real()), root)).toThrow(
        "figure checkout-flow: docs/diagrams/checkout-flow.figure.svg is not built; run scripts/build-figure.sh checkout-flow",
      );
    }));
});

describe("the CLI", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  const expectExit = (r: ReturnType<typeof run>, code: number) => {
    if (r.status !== code)
      throw new Error(
        `expected exit ${code}, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
  };
  const head = spawnSync("git", ["rev-parse", "--short=10", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();

  function sourceFile(commit: string): { path: string; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "explainer-cli-"));
    const s = minimal();
    s.verifiedAt.commit = commit;
    // A file this repository holds at every commit the suite runs on, so the freshness guard can resolve it.
    (s.sections[0]?.claims[0] as { source: string }).source = "AGENTS.md";
    const path = join(dir, "source.json");
    writeFileSync(path, JSON.stringify(s));
    return { path, out: join(dir, "out") };
  }

  it("renders the sheet and the markdown, and extracts the source back from the sheet", () => {
    const { path, out } = sourceFile(head);
    const r = run(["render", path, "--out", out]);
    expectExit(r, 0);
    const sheet = join(out, `minimal${SHEET_FILENAME_SUFFIX}`);
    expect(existsSync(sheet)).toBe(true);
    expect(existsSync(join(out, "minimal.md"))).toBe(true);
    const back = run(["extract", sheet]);
    expectExit(back, 0);
    expect(JSON.parse(back.stdout)).toEqual(
      JSON.parse(readFileSync(path, "utf8")),
    );
  });

  it("--require-fresh refuses a commit this clone does not have, and writes nothing", () => {
    const { path, out } = sourceFile("0000000000");
    const r = run(["render", path, "--out", out, "--require-fresh"]);
    expectExit(r, 3);
    expect(existsSync(out)).toBe(false);
  });

  it("checks the checkout it runs in when git variables point at another", () => {
    const { path, out } = sourceFile(head);
    const env = gitIdentityEnv();
    const other = mkdtempSync(join(tmpdir(), "explainer-other-"));
    spawnSync("git", ["init", "-q"], { cwd: other, env });
    const r = spawnSync(
      process.execPath,
      [SCRIPT, "render", path, "--out", out, "--require-fresh"],
      {
        encoding: "utf8",
        env: { ...env, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other },
      },
    );
    expectExit(r, 0);
    expect(existsSync(out)).toBe(true);
  });

  it("rejects an invalid source and an unknown flag with exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "explainer-cli-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...minimal(), id: "Bad Id" }));
    expectExit(run(["validate", bad]), 1);
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(minimal()));
    expectExit(run(["validate", good]), 0);
    const flagged = run(["validate", good, "--template", "x"]);
    expectExit(flagged, 1);
    expect(flagged.stderr).toContain("unknown flag for validate: --template");
  });

  it("rejects a misspelled flag after a repeated --out, and a repeated flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "explainer-cli-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(minimal()));
    const out = join(dir, "out");
    const typo = run([
      "render",
      good,
      "--out",
      out,
      "--out",
      "--require-fersh",
    ]);
    expectExit(typo, 1);
    expect(typo.stderr).toContain("unknown flag for render: --require-fersh");
    const twice = run(["render", good, "--out", out, "--out", join(dir, "o2")]);
    expectExit(twice, 1);
    expect(twice.stderr).toContain(
      "flag given more than once for render: --out",
    );
    expect(existsSync(out)).toBe(false);
  });
});

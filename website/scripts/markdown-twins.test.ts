import { expect, test } from "bun:test";
import { htmlToMarkdown, linkedAnchors, twinHref } from "./markdown-twins.ts";

const known = new Set(["/", "/modules/", "/modules/M2/", "/glossary/"]);
const page = (main: string) =>
  `<html><body><header><a href="/">Jig</a></header><main id="main">${main}</main><footer>foot</footer></body></html>`;
const md = (
  main: string,
  route = "/modules/M2/",
  anchors: ReadonlySet<string> = new Set(),
) => htmlToMarkdown(page(main), route, known, anchors);

test("only the page's main content is kept, without what is for a screen", async () => {
  const out = await md(
    `<nav class="crumbs"><a href="/modules/">Modules</a></nav>
     <h1>Title</h1><button>Copy</button><svg><title>x</title></svg>
     <div class="tabs" hidden><span>Lite</span></div>
     <p>Body <kbd>/</kbd></p><div hidden>secret</div>`,
  );
  expect(out).toBe("# Title\n\nBody\n");
});

test("a styled section label becomes a heading", async () => {
  const out = await md(
    `<div class="section-head" id="idea"><span class="label">1 · The idea</span><span class="note">read this first</span></div><p>Text</p>`,
  );
  expect(out).toBe("## 1 · The idea\n\nread this first\n\nText\n");
});

test("labels set apart by styling are separated in text", async () => {
  const out = await md(`<p><span>Invariant</span><span>the rule</span></p>`);
  expect(out).toBe("Invariant the rule\n");
});

test("a link to a page goes to its twin and keeps its anchor", () => {
  expect(twinHref("/modules/M2/", "/", known)).toBe(
    "https://jig-harness.dev/modules/M2/index.md",
  );
  expect(twinHref("/glossary/#invariant", "/modules/M2/", known)).toBe(
    "https://jig-harness.dev/glossary/index.md#invariant",
  );
  expect(twinHref("#strict", "/modules/M2/", known)).toBe(
    "https://jig-harness.dev/modules/M2/index.md#strict",
  );
  expect(twinHref("../M3/", "/modules/M2/", new Set(["/modules/M3/"]))).toBe(
    "https://jig-harness.dev/modules/M3/index.md",
  );
  expect(twinHref("/?profile=strict#p", "/modules/M2/", known)).toBe(
    "https://jig-harness.dev/index.md?profile=strict#p",
  );
});

test("an id a twin links to is kept as an anchor where its element begins", async () => {
  const anchors = linkedAnchors(
    new Map([
      [
        "/",
        page(`<a href="/modules/M2/#strict">s</a><a href="/glossary/">g</a>`),
      ],
      ["/glossary/", page(`<a href="/modules/M2/#maturity-levels">m</a>`)],
    ]),
    known,
  );
  expect([...(anchors.get("/modules/M2/") ?? [])].sort()).toEqual([
    "maturity-levels",
    "strict",
  ]);
  expect(anchors.has("/glossary/")).toBe(false);
  const out = await md(
    `<div class="section-head" id="maturity-levels"><span class="label">2 · The practice</span></div><div id="strict"><p>Strict</p></div><p id="unused">Other</p>`,
    "/modules/M2/",
    anchors.get("/modules/M2/"),
  );
  expect(out).toContain('## <a id="maturity-levels"></a>2 · The practice');
  expect(out).toContain('<a id="strict"></a>');
  expect(out).not.toContain("unused");
});

test("a mark that means something only by its label says it in text", async () => {
  const out = await md(
    `<ul><li><span class="rung mechanical" role="img" aria-label="must be mechanically enforced"></span><span>Gates run</span></li></ul>`,
  );
  expect(out).toBe("- (must be mechanically enforced) Gates run\n");
});

test("every choice of a radio group and the panel shown for it are kept", async () => {
  const out = await md(
    `<div role="radiogroup"><button type="button" role="radio" data-profile="0" class="card"><span class="q">Shipping weekly?</span><span class="answer">Standard</span></button><button type="button" role="radio" data-profile="1" class="card"><span class="q">Regulated?</span><span class="answer">Strict</span></button></div>
     <div class="prose rationale" data-for-profile="0"><p>Why standard.</p></div>
     <div class="prose rationale" data-for-profile="1" hidden><p>Why strict.</p></div>
     <div class="cmd"><code>/jig:audit</code><button type="button" class="copy">Copy</button></div>`,
  );
  expect(out).toContain("Regulated? Strict");
  expect(out).toContain("### Strict\n\nWhy strict.");
  expect(out).toContain("### Standard\n\nWhy standard.");
  expect(out).not.toContain("Copy");
});

test("an image's address is resolved against the page it is on", async () => {
  const out = await md(`<p><img src="diagram.png" alt="Diagram"></p>`);
  expect(out).toContain("https://jig-harness.dev/modules/M2/diagram.png");
});

test("a file of the site is linked by its address, another site's link is left alone", () => {
  expect(twinHref("/examples/audit/sheet.html#m1", "/", known)).toBe(
    "https://jig-harness.dev/examples/audit/sheet.html#m1",
  );
  expect(twinHref("https://github.com/x/y#z", "/", known)).toBe(
    "https://github.com/x/y#z",
  );
  expect(twinHref("mailto:a@b.c", "/", known)).toBe("mailto:a@b.c");
});

test("adjacent links each get a line", async () => {
  const out = await md(
    `<div><a href="/modules/">A</a><a href="/glossary/">B</a></div>`,
  );
  expect(out).toBe(
    "[A](https://jig-harness.dev/modules/index.md)\\\n[B](https://jig-harness.dev/glossary/index.md)\n",
  );
});

test("code and tables keep their shape", async () => {
  const out = await md(
    `<figure class="code"><figcaption><span>ts</span></figcaption><pre><code class="language-ts">const a = 1;</code></pre></figure><table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>`,
  );
  expect(out).toContain("```ts\nconst a = 1;\n```");
  expect(out).not.toMatch(/^ts$/m);
  expect(out).toContain("| A |\n| - |\n| 1 |");
});

test("a highlighted code block keeps its language and every character of its code", async () => {
  const out = await md(
    `<figure class="code"><figcaption><span>ts</span><button class="copy">Copy</button></figcaption><pre class="astro-code" data-language="ts"><code><span class="line"><span>const</span><span> re</span><span>=</span><span>/a</span><span>b/</span></span></code></pre></figure>`,
  );
  expect(out).toBe("```ts\nconst re=/ab/\n```\n");
});

test("a code block's caption names its language when the block does not", async () => {
  const out = await md(
    `<figure class="code"><figcaption><span>yaml</span></figcaption><pre><code>a: 1</code></pre></figure>`,
  );
  expect(out).toBe("```yaml\na: 1\n```\n");
});

test("a mark labelled without an image role still says its label", async () => {
  const out = await md(
    `<p><span class="dot" aria-label="Practised: target"></span><span>Gates</span></p>`,
  );
  expect(out).toBe("(Practised: target) Gates\n");
});

test("a module map cell says its level's state under every profile", async () => {
  const switcher = `<div role="radiogroup"><button role="radio" data-profile="0">Lite</button><button role="radio" data-profile="1">Strict</button></div>`;
  const compact = await md(
    `${switcher}<a class="compact-row" href="/modules/M2/"><span class="cid">M2</span><span class="cell" data-states="off on" data-state="off" aria-label="Practised: not targeted"></span></a>`,
  );
  expect(compact).toContain("Practised (Lite: not targeted; Strict: target)");
  const full = await md(
    `${switcher}<div class="cells"><a class="cell big" href="/modules/M2/#practised" data-states="cond off" data-state="cond">Practised<span class="if"> if</span></a></div>`,
  );
  expect(full).toContain(
    "[Practised (Lite: target only if its condition holds; Strict: not targeted)]",
  );
  expect(full).not.toMatch(/ if\]/);
});

test("every address of a page leads to its twin", () => {
  expect(twinHref("/modules/M2", "/", known)).toBe(
    "https://jig-harness.dev/modules/M2/index.md",
  );
  expect(twinHref("/modules/M2/index.html#strict", "/", known)).toBe(
    "https://jig-harness.dev/modules/M2/index.md#strict",
  );
  expect(twinHref("/index.html", "/glossary/", known)).toBe(
    "https://jig-harness.dev/index.md",
  );
  const anchors = linkedAnchors(
    new Map([["/", page(`<a href="/modules/M2/index.html#strict">s</a>`)]]),
    known,
  );
  expect([...(anchors.get("/modules/M2/") ?? [])]).toEqual(["strict"]);
});

test("a link whose marks are hidden glyphs says its label", async () => {
  const out = await md(
    `<ol><li><a class="box" href="/modules/#station-a1" aria-label="Design 1, Shape: run by a skill, with an agent"><span class="n">1</span><span class="name">Shape</span><span class="marks" aria-hidden="true"><span class="mark cap skill">/</span></span></a></li></ol>`,
  );
  expect(out).toContain(
    "[Design 1, Shape: run by a skill, with an agent](https://jig-harness.dev/modules/index.md#station-a1)",
  );
});

test("a legend that keys marks is left out, but the text it shows per choice is kept", async () => {
  const key = await md(
    `<p>Before</p><div class="legend" role="list"><span role="listitem"><span class="mark" aria-hidden="true">/</span>a skill</span></div><p>After</p>`,
  );
  expect(key).toBe("Before\n\nAfter\n");
  const counts = await md(
    `<div role="radiogroup"><button role="radio" data-profile="0">Lite</button><button role="radio" data-profile="1">Strict</button></div><p class="legend"><span data-for-profile="0"><strong>Lite</strong> targets 5 of 20 modules.</span><span data-for-profile="1" hidden><strong>Strict</strong> targets 20 of 20 modules.</span><span class="key on"></span> target</p>`,
  );
  expect(counts).toContain("**Lite** targets 5 of 20 modules.\n\n");
  expect(counts).toContain("**Strict** targets 20 of 20 modules.");
  expect(counts).not.toContain("#");
  expect(counts).not.toContain(" target\n");
});

test("a panel set in a line opens with its choice's name when it does not say it", async () => {
  const out = await md(
    `<div role="radiogroup"><button role="radio" data-profile="0">Lite</button><button role="radio" data-profile="1">Strict</button></div><p>Plan: <span data-for-profile="0">3 modules</span><span data-for-profile="1" hidden>15 modules</span></p>`,
  );
  expect(out).toContain("**Lite**: 3 modules");
  expect(out).toContain("**Strict**: 15 modules");
  expect(out).not.toContain("#");
});

test("an id a twin links to is kept wherever its element is: in code, in replaced text, in what is left out, on what keeps no content", async () => {
  const IDS = [
    "call",
    "block",
    "sample",
    "label",
    "crumbs",
    "break",
    "diagram",
    "rule",
    "frame",
    "caption",
  ];
  const out = await md(
    `<p>See <code id="call">run()</code>.</p><figure class="code"><pre id="block"><code id="sample"><span>example</span><span>()</span></code></pre></figure><div class="section-head"><span class="label" id="label">3 · More</span></div><nav class="crumbs" id="crumbs"><a href="/">Home</a></nav><p>Before<br id="break">after <img id="diagram" src="/diagram.png" alt="Diagram"></p><hr id="rule"><iframe id="frame" src="/demo/"></iframe><table><caption id="caption">Table</caption><tr><td>1</td></tr></table>`,
    "/modules/M2/",
    new Set(IDS),
  );
  for (const id of IDS) expect(out).toContain(`<a id="${id}"></a>`);
  expect(out).toContain("```\nexample()\n```");
  expect(out).toContain("`run()`");
  expect(out).not.toContain("Home");
  expect(out).toContain("![Diagram](https://jig-harness.dev/diagram.png)");
});

test("an id a twin links to is kept on every element whose conversion keeps none of its children", async () => {
  const IDS = ["captions", "hotspot", "wide", "column", "fallback", "row"];
  const out = await md(
    `<video src="/demo.mp4"><track id="captions" src="/captions.vtt"></video><map name="m"><area id="hotspot" href="/"></map><picture><source id="wide" srcset="/wide.png"><img src="/narrow.png" alt="Diagram"></picture><table><colgroup><col id="column"></colgroup><tr id="row"><td>1</td></tr></table><video src="/talk.mp4" poster="/talk.png"><span id="fallback">The talk</span></video>`,
    "/modules/M2/",
    new Set(IDS),
  );
  for (const id of IDS) expect(out).toContain(`<a id="${id}"></a>`);
});

test("an id a twin links to is kept where its element's conversion depends on what the element is in", async () => {
  const IDS = ["inner", "cell"];
  const out = await md(
    `<table><tr><td><table id="inner"><tr><td id="cell">Details</td><td><span aria-label="must be mechanically enforced"></span>Gates run<button>Copy</button></td></tr></table></td></tr></table>`,
    "/modules/M2/",
    new Set(IDS),
  );
  for (const id of IDS) expect(out.split(`<a id="${id}"></a>`)).toHaveLength(2);
  expect(out).toContain("Details");
  expect(out).toContain("(must be mechanically enforced)");
  expect(out).toContain("Gates run");
  expect(out).not.toContain("Copy");
});

test("a % that starts no escape is matched as written, not a build failure", () => {
  expect(twinHref("/modules/M2/100%", "/", known)).toBe(
    "https://jig-harness.dev/modules/M2/100%",
  );
  const anchors = linkedAnchors(
    new Map([
      [
        "/",
        page(
          `<a href="/modules/M2/#100%">p</a><a href="/modules/M2/#café100%">q</a>`,
        ),
      ],
    ]),
    known,
  );
  expect([...(anchors.get("/modules/M2/") ?? [])]).toEqual([
    "100%",
    "café100%",
  ]);
});

test("an address is written as parsed: decoding finds the page, never writes it", () => {
  expect(twinHref("/files/%2541%zz.txt", "/", known)).toBe(
    "https://jig-harness.dev/files/%2541%zz.txt",
  );
  expect(twinHref("/files/a%5Cb%0A", "/", known)).toBe(
    "https://jig-harness.dev/files/a%5Cb%0A",
  );
  const odd = new Set(["/notes/100%/", "/notes/café/"]);
  expect(twinHref("/notes/100%25/", "/", odd)).toBe(
    "https://jig-harness.dev/notes/100%25/index.md",
  );
  expect(twinHref("/notes/caf%C3%A9/#x", "/", odd)).toBe(
    "https://jig-harness.dev/notes/caf%C3%A9/index.md#x",
  );
  const anchors = linkedAnchors(
    new Map([["/", page(`<a href="/notes/100%25/#y">p</a>`)]]),
    odd,
  );
  expect([...(anchors.get("/notes/100%/") ?? [])]).toEqual(["y"]);
});

test("a page whose route holds reserved characters is found and its anchors kept", () => {
  const reserved = new Set(["/notes/a&b/", "/notes/x@y+z;=$,:/"]);
  expect(twinHref("/notes/a&b/#x", "/", reserved)).toBe(
    "https://jig-harness.dev/notes/a%26b/index.md#x",
  );
  expect(twinHref("/notes/a%26b/#x", "/", reserved)).toBe(
    "https://jig-harness.dev/notes/a%26b/index.md#x",
  );
  expect(twinHref("/notes/x@y+z;=$,:/", "/", reserved)).toBe(
    "https://jig-harness.dev/notes/x%40y%2Bz%3B%3D%24%2C%3A/index.md",
  );
  const anchors = linkedAnchors(
    new Map([
      [
        "/",
        page(
          `<a href="/notes/a&b/#x">p</a><a href="/notes/x@y+z;=$,:/#y">q</a>`,
        ),
      ],
    ]),
    reserved,
  );
  expect([...(anchors.get("/notes/a&b/") ?? [])]).toEqual(["x"]);
  expect([...(anchors.get("/notes/x@y+z;=$,:/") ?? [])]).toEqual(["y"]);
});

test("a link on a page whose route holds a ? or # resolves against that page", () => {
  const odd = new Set(["/notes/a?b/", "/notes/c#d/", "/notes/e/"]);
  expect(twinHref("#x", "/notes/a?b/", odd)).toBe(
    "https://jig-harness.dev/notes/a%3Fb/index.md#x",
  );
  expect(twinHref("../e/", "/notes/c#d/", odd)).toBe(
    "https://jig-harness.dev/notes/e/index.md",
  );
  const anchors = linkedAnchors(
    new Map([["/notes/a?b/", page(`<a href="#x">p</a>`)]]),
    odd,
  );
  expect([...(anchors.get("/notes/a?b/") ?? [])]).toEqual(["x"]);
});

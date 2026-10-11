/**
 * Browser checks of the explainer sheet: what only a rendered page can show.
 * No network request and no console error, with and without JavaScript;
 * every section visible with JavaScript off and in print; the figure drawn in
 * colour, its text findable on the page; step tracing on hover and on
 * keyboard focus.
 *
 * It drives the installed Google Chrome through `playwright-core`. Where
 * Chrome is missing the checks cannot run, so they are skipped and the run
 * says so in a warning. An environment that must run them sets
 * `GROUNDWORK_REQUIRE_BROWSER=1`; there a missing browser is a failing test,
 * so a suite that never ran cannot read as a pass.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, Element } from "happy-dom";
import { type Browser, chromium, type Page } from "playwright-core";
import { renderExplainerHtml } from "../scripts/explainer-sheet/html.ts";
import { parseSource, plainText } from "../scripts/explainer-sheet/source.ts";

// The callbacks passed to `page.evaluate` run in Chrome, not in Bun. The
// repository compiles without the DOM library, so the page globals they use
// are declared here, for this file only, with happy-dom's DOM types.
declare const document: BrowserWindow["document"];
declare const window: BrowserWindow;
declare const getComputedStyle: BrowserWindow["getComputedStyle"];
declare const SVGGeometryElement: BrowserWindow["SVGGeometryElement"];

const FIXTURES = join(import.meta.dir, "fixtures/explainer-sheet");
const source = parseSource(
  JSON.parse(readFileSync(join(FIXTURES, "order-checkout.json"), "utf8")),
);
const figure = readFileSync(
  join(FIXTURES, "checkout-flow.figure.svg.txt"),
  "utf8",
).trim();

const dir = mkdtempSync(join(tmpdir(), "explainer-sheet-browser-"));
const file = join(dir, "order-checkout.html");
writeFileSync(
  file,
  renderExplainerHtml(source, new Map([["checkout-flow", figure]])),
);
const URL_ = pathToFileURL(file).href;

let browser: Browser | undefined;
let missing = "";
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
} catch (err) {
  missing = (err as Error).message.split("\n")[0] ?? "Chrome did not start";
}
afterAll(async () => {
  await browser?.close();
  rmSync(dir, { recursive: true, force: true });
});

const required = process.env.GROUNDWORK_REQUIRE_BROWSER === "1";
if (!browser && required)
  it("a browser is available", () => {
    throw new Error(
      `these checks need Google Chrome and found none (${missing}); GROUNDWORK_REQUIRE_BROWSER=1 makes a missing browser fail instead of skipping`,
    );
  });
if (!browser && !required)
  console.warn(
    `explainer browser checks skipped, Google Chrome did not start: ${missing}`,
  );

const run = browser ? it : it.skip;

async function open(
  js: boolean,
  width = 1440,
): Promise<{ page: Page; requests: string[]; errors: string[] }> {
  const context = await (browser as Browser).newContext({
    javaScriptEnabled: js,
    viewport: { width, height: 900 },
  });
  const page = await context.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith("file:")) requests.push(r.url());
  });
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL_);
  return { page, requests, errors };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** What the source promises the page lists, in every mode: identities and bodies, not totals. */
const expected = {
  sections: source.sections.map((x) => `sec-${x.id}`),
  steps: (source.flow ?? []).map((s) => ({
    id: `step-${s.id}`,
    title: s.title,
    source: s.source,
  })),
  claimSources: source.sections.flatMap((x) => x.claims.map((c) => c.source)),
  // Step tokens are written out as words on the page; term tooltips are left out of the compared text.
  claimBodies: source.sections.flatMap((x) =>
    x.claims.map((c) => squash(plainText(c.text))),
  ),
  stepBodies: (source.flow ?? []).map((s) => squash(plainText(s.text))),
  questions: (source.openQuestions ?? []).map((q) => squash(plainText(q))),
};

/** What the page holds now, after any script has run. Compared before visibility, so a removed item cannot hide behind the survivors. */
const inventory = (page: Page) =>
  page.evaluate(() => {
    const text = (el: Element) =>
      (el.textContent ?? "").replace(/\s+/g, " ").trim();
    /** The text of an element without its term tooltips, which the source does not hold. */
    const bare = (el: Element | null) => {
      if (!el) return "";
      const copy = el.cloneNode(true) as Element;
      for (const tip of copy.querySelectorAll(".tip")) tip.remove();
      return text(copy);
    };
    const claims = [...document.querySelectorAll(".claims li")];
    const questions = [...document.querySelectorAll(".oq li")];
    return {
      sections: [...document.querySelectorAll("section[id]")].map((e) => e.id),
      steps: [...document.querySelectorAll(".steps li")].map((li) => ({
        id: li.id,
        title: text(li.querySelector("h3 > span") ?? li),
        source: text(li.querySelector(".src code") ?? li),
      })),
      claimSources: claims.map((li) =>
        text(li.querySelector(".src code") ?? li),
      ),
      claimBodies: claims.map((li) => bare(li.querySelector(".main"))),
      stepBodies: [...document.querySelectorAll(".steps li")].map((li) =>
        bare(li.querySelector(".main > p")),
      ),
      questions: questions.map(bare),
    };
  });

async function expectWholePage(page: Page) {
  const found = await inventory(page);
  expect(found.sections).toEqual(expect.arrayContaining(expected.sections));
  expect(found.steps).toEqual(expected.steps);
  expect(found.claimSources).toEqual(expected.claimSources);
  // Bodies and questions are compared with their source text, so an emptied or swapped item cannot pass on its title and citation alone.
  expect(found.claimBodies).toEqual(expected.claimBodies);
  expect(found.stepBodies).toEqual(expected.stepBodies);
  expect(found.questions).toEqual(expected.questions);
}

/** Every section and every claim, and whether the reader can see it. */
const visibility = (page: Page) =>
  page.evaluate(() =>
    [
      ...document.querySelectorAll("section, .claims li, .steps li, .oq li"),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        id: el.id || el.textContent?.slice(0, 40),
        visible:
          r.width > 0 &&
          r.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none",
      };
    }),
  );

describe("network and console", () => {
  for (const js of [true, false])
    run(
      `makes no network request and logs no error, JavaScript ${js ? "on" : "off"}`,
      async () => {
        const { page, requests, errors } = await open(js);
        await page.waitForTimeout(200);
        expect(requests).toEqual([]);
        expect(errors).toEqual([]);
        await page.context().close();
      },
    );
});

describe("content without JavaScript and in print", () => {
  run(
    "shows every section, step, claim and open question with JavaScript off",
    async () => {
      const { page } = await open(false);
      await expectWholePage(page);
      const items = await visibility(page);
      expect(items.filter((i) => !i.visible)).toEqual([]);
      await page.context().close();
    },
  );

  run(
    "shows every section, step, claim and open question in print, and hides the bar",
    async () => {
      const { page } = await open(true);
      await page.emulateMedia({ media: "print" });
      await expectWholePage(page);
      const items = await visibility(page);
      expect(items.filter((i) => !i.visible)).toEqual([]);
      expect(
        await page.evaluate(
          () =>
            getComputedStyle(document.querySelector(".bar") as Element).display,
        ),
      ).toBe("none");
      await page.context().close();
    },
  );
});

describe("the figure", () => {
  run(
    "is drawn in colour: no shape of a styled class is filled solid black",
    async () => {
      const { page } = await open(false);
      const fills = await page.evaluate(() =>
        [...document.querySelectorAll("#fig-checkout-flow [class]")]
          .filter((el) => el instanceof SVGGeometryElement)
          .map((el) => getComputedStyle(el).fill),
      );
      expect(fills.length).toBeGreaterThan(5);
      expect(fills.filter((f) => f === "rgb(0, 0, 0)")).toEqual([]);
      await page.context().close();
    },
  );

  run("its text is real text, so find-in-page reaches it", async () => {
    const { page } = await open(false);
    const found = await page.evaluate(() => {
      const svg = document.querySelector("#fig-checkout-flow");
      return [...(svg?.querySelectorAll("text") ?? [])].map(
        (t) => t.textContent,
      );
    });
    expect(found).toContain("Retry sweep");
    // `window.find` is what Ctrl-F drives.
    expect(
      await page.evaluate(() =>
        (window as unknown as { find: (s: string) => boolean }).find(
          "Retry sweep",
        ),
      ),
    ).toBe(true);
    await page.context().close();
  });

  run("keeps its classes and ids apart from the sheet", async () => {
    const { page } = await open(false);
    const leaks = await page.evaluate(() =>
      [...document.querySelectorAll("[id]")]
        .filter(
          (el) => el.closest("svg") && !el.id.startsWith("fig-checkout-flow"),
        )
        .map((el) => el.id),
    );
    expect(leaks).toEqual([]);
    await page.context().close();
  });
});

describe("step tracing", () => {
  run(
    "lights the step a reference names, on hover and on keyboard focus",
    async () => {
      const { page } = await open(true);
      const ref = page.locator('a.ref[data-t^="s-"]').first();
      const key = await ref.getAttribute("data-t");
      await ref.hover();
      expect(
        await page.locator(`li.step[data-t="${key}"]`).getAttribute("class"),
      ).toContain("hl");
      await page.mouse.move(0, 0);
      expect(
        await page.locator(`li.step[data-t="${key}"]`).getAttribute("class"),
      ).not.toContain("hl");
      await ref.focus();
      expect(
        await page.locator(`li.step[data-t="${key}"]`).getAttribute("class"),
      ).toContain("hl");
      const outline = await ref.evaluate(
        (el) => getComputedStyle(el).outlineStyle,
      );
      expect(outline).not.toBe("none");
      await page.context().close();
    },
  );
});

describe("narrow screen", () => {
  for (const width of [390, 720])
    run(`has no sideways scroll at ${width} px`, async () => {
      const { page } = await open(true, width);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.context().close();
    });
});

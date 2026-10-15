/**
 * Browser checks of the audit sheet: what only a rendered page can show.
 * No network request and no console error, with and without JavaScript;
 * every section and recommendation visible with JavaScript off and in print,
 * with the choices hidden; choosing, the conditional targets of the chosen
 * profile, flagging a score as wrong, the tray's counts and the copied text,
 * which must equal `feedbackText` for the same choices; the choices restored
 * from `localStorage`; no sideways scroll on a narrow screen.
 *
 * It drives the installed Google Chrome through `playwright-core`. Where
 * Chrome is missing the checks cannot run, so they are skipped and the run
 * says so in a warning. An environment that must run them sets
 * `JIG_REQUIRE_BROWSER=1`; there a missing browser is a failing test.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow, Element } from "happy-dom";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { feedbackText } from "../scripts/report/feedback-text.ts";
import { renderReportHtml } from "../scripts/report/html.ts";
import { reportFingerprint } from "../scripts/report/source.ts";
import {
  COMMIT,
  historyRecord,
  noProfile,
  priorRecord,
  recordText,
  reportInput,
} from "./report-fixtures.ts";

// The callbacks passed to `page.evaluate` run in Chrome, not in Bun. The
// repository compiles without the DOM library, so the page globals they use
// are declared here, for this file only, with happy-dom's DOM types.
declare const document: BrowserWindow["document"];
declare const window: BrowserWindow & { copied?: string };
declare const getComputedStyle: BrowserWindow["getComputedStyle"];
declare const Event: BrowserWindow["Event"];
declare const KeyboardEvent: BrowserWindow["KeyboardEvent"];
declare const requestAnimationFrame: BrowserWindow["requestAnimationFrame"];

// Solo/Lite suggested, heading to Team/Standard: R1, R2 and R4 are for now,
// R3 and R5 (each with a lighter option) wait in the "as you grow" group.
// One gap (the glossary) has no recommendation; a signal suggests revisiting
// the profile; a prior and an older record give the trend.
const input = reportInput({
  record: recordText(["heading_to: team-standard"]),
  prior: priorRecord(),
  history: [historyRecord()],
  source: (s) => {
    (s.profile as Record<string, unknown>).signals = [
      {
        text: "Seven people committed in the last quarter.",
        evidence: ["git shortlog -sn --since=3.months"],
      },
    ];
  },
});
const dir = mkdtempSync(join(tmpdir(), "audit-sheet-browser-"));
const file = join(dir, "jig-audit.html");
writeFileSync(file, renderReportHtml(input));
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

const required = process.env.JIG_REQUIRE_BROWSER === "1";
if (!browser && required)
  it("a browser is available", () => {
    throw new Error(
      `these checks need Google Chrome and found none (${missing}); JIG_REQUIRE_BROWSER=1 makes a missing browser fail instead of skipping`,
    );
  });
if (!browser && !required)
  console.warn(
    `audit sheet browser checks skipped, Google Chrome did not start: ${missing}`,
  );

const run = browser ? it : it.skip;

/** The page's clipboard, replaced so a test can read what the copy button wrote. */
const STUB_CLIPBOARD = `Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:function(t){window.copied=t;return Promise.resolve()}}})`;

async function open(
  js: boolean,
  width = 1440,
  context?: BrowserContext,
): Promise<{ page: Page; requests: string[]; errors: string[] }> {
  const ctx =
    context ??
    (await (browser as Browser).newContext({
      javaScriptEnabled: js,
      viewport: { width, height: 900 },
    }));
  await ctx.addInitScript(STUB_CLIPBOARD);
  const page = await ctx.newPage();
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

/** Each section, each recommendation and each criterion, and whether the reader can see it. */
const visibility = (page: Page) =>
  page.evaluate(() => {
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none"
      );
    };
    const all = (q: string) => [...document.querySelectorAll(q)];
    return {
      hidden: all(
        "section[id], .rec, .crit li, .mrow, #signals, #uncovered, .trend, .c.unc",
      )
        .filter((el) => !seen(el))
        .map((el) => el.id || (el.textContent ?? "").slice(0, 40)),
      recs: all(".rec").map((el) => el.id),
      choicesShown: all(".choose, .psel, #tray").filter(seen).length,
    };
  });

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

describe("without JavaScript and in print", () => {
  const allRecs = input.source.recommendations.map((r) => `rec-${r.id}`);

  run(
    "shows every section, recommendation and criterion, and none of the choices",
    async () => {
      const { page } = await open(false);
      const v = await visibility(page);
      expect(v.hidden).toEqual([]);
      expect(v.recs).toEqual(expect.arrayContaining(allRecs));
      expect(v.choicesShown).toBe(0);
      await page.context().close();
    },
  );

  run(
    "prints everything, the folded groups opened, without the bar, the choices or the tray",
    async () => {
      const { page } = await open(true);
      await page.click("#rec-R1 .ch-accept span");
      await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
      await page.emulateMedia({ media: "print" });
      const v = await visibility(page);
      expect(v.hidden).toEqual([]);
      expect(v.choicesShown).toBe(0);
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

describe("choosing", () => {
  run(
    "folds the later recommendations until the reader opens them",
    async () => {
      const { page } = await open(true);
      expect(await page.locator("#h-grow").getAttribute("open")).toBeNull();
      expect(await page.locator("#rec-R3").isVisible()).toBe(false);
      await page.click("#h-grow summary");
      expect(await page.locator("#rec-R3").isVisible()).toBe(true);
      await page.context().close();
    },
  );

  run(
    "counts the choices, holds back a decline without its reason, and copies exactly the agreed text",
    async () => {
      const { page } = await open(true);
      expect(await page.locator("#tray").isVisible()).toBe(false);
      await page.click("#rec-R1 .ch-accept span");
      expect(await page.locator("#tray").isVisible()).toBe(true);
      await page.click("#rec-R2 .ch-refine span");
      await page.fill('#rec-R2 [data-f="note"]', 'Keep it to "one" page.');
      await page.click("#h-grow summary");
      await page.click("#rec-R3 .ch-lighter span");
      await page.click("#rec-R5 .ch-decline span");
      await page.fill('#rec-R5 [data-f="reason"]', "Two maintainers.");
      await page.click("#rec-R4 .ch-wrong span");
      await page.fill('#rec-R4 [data-f="note"]', "Already set upstream.");
      // The record has no profile: conditional targets appear once one is chosen.
      expect(await page.locator("fieldset.conds:visible").count()).toBe(0);
      await page.selectOption("#profile-pick", "team-standard");
      const conds = page.locator('fieldset[data-prof="team-standard"]');
      expect(await conds.isVisible()).toBe(true);
      expect(await conds.innerText()).toContain(
        "M3 Change area catalog (Lite) applies when what a change implies is no longer obvious from its paths",
      );
      await conds.locator('input[value="M3"]').check();
      await page.click("#d-M3");
      const flag = page.locator('li[data-crit="M3/consumer-view-generated"]');
      await flag.locator("[data-sw]").check();
      expect(await flag.getAttribute("data-flag")).toBe("");

      const counts = await page.locator("#tray .counts").innerText();
      expect(counts.replace(/\s+/g, " ")).toBe(
        "Accept 1 Take the lighter option 1 Refine 1 Decline 1 This is wrong 1 profile team-standard conditional targets M3 Scores flagged wrong 1",
      );
      expect(await page.locator("#tray .miss").innerText()).toBe(
        "Not ready to copy: R5 needs when to revisit; M3/consumer-view-generated needs a note.",
      );
      expect(await page.locator('[data-act="copy"]').isDisabled()).toBe(true);

      await page.fill('#rec-R5 [data-f="when"]', "a third maintainer joins");
      await flag
        .locator("[data-swn]")
        .fill('The "docs" build generates the view.');
      expect(await page.locator("#tray .miss").isVisible()).toBe(false);
      await page.click('[data-act="copy"]');
      await page.waitForFunction(() => window.copied !== undefined);
      const copied = await page.evaluate(() => window.copied);
      const expected = feedbackText(
        {
          repository: input.source.repository.name,
          commit: COMMIT,
          report: reportFingerprint(input.source.recommendations),
          date: input.record.date,
          recommendations: input.source.recommendations,
        },
        {
          profile: "team-standard",
          conditions: ["M3"],
          scores: {
            "M3/consumer-view-generated":
              'The "docs" build generates the view.',
          },
          decisions: {
            R1: { choice: "accept" },
            R2: { choice: "refine", note: 'Keep it to "one" page.' },
            R3: { choice: "lighter" },
            R4: { choice: "wrong", note: "Already set upstream." },
            R5: {
              choice: "decline",
              reason: "Two maintainers.",
              revisit_when: "a third maintainer joins",
            },
          },
        },
      );
      expect(copied).toBe(expected);
      expect(copied).toContain("\n  profile_conditions: [M3]\n");
      expect(copied).toContain(
        '\n  scores:\n    - { ref: "M3/consumer-view-generated", note: "The \\"docs\\" build generates the view." }',
      );
      // The preview opens on copy and shows the same text.
      expect(await page.locator("#preview").innerText()).toBe(expected);
      await page.context().close();
    },
  );

  run(
    "offers a condition only the heading-to profile has, and lets the reader untick it",
    async () => {
      const ahead = join(dir, "heading-to.html");
      writeFileSync(
        ahead,
        renderReportHtml(
          reportInput({
            record: recordText([
              "profile: solo-lite",
              "heading_to: team-standard",
              "profile_conditions: [M12]",
            ]),
            source: noProfile,
          }),
        ),
      );
      const ctx = await (browser as Browser).newContext({
        viewport: { width: 1440, height: 900 },
      });
      await ctx.addInitScript(STUB_CLIPBOARD);
      const page = await ctx.newPage();
      await page.goto(pathToFileURL(ahead).href);
      const box = page.locator(
        'fieldset[data-prof="solo-lite"] input[value="M12"]',
      );
      expect(await box.isVisible()).toBe(true);
      expect(await box.isChecked()).toBe(true);
      await box.uncheck();
      expect(await page.locator("#tray").isVisible()).toBe(true);
      expect(
        (await page.locator("#tray .counts").innerText()).replace(/\s+/g, " "),
      ).toBe(
        "Accept 0 Take the lighter option 0 Refine 0 Decline 0 This is wrong 0 conditional targets none",
      );
      // Reset restores the record's conditions and forgets the stored choice.
      await page.click('[data-act="reset"]');
      expect(await box.isChecked()).toBe(true);
      expect(await page.locator("#tray").isVisible()).toBe(false);
      expect(
        await page.evaluate(() => Object.keys(window.localStorage)),
      ).toEqual([]);
      await ctx.close();
    },
  );

  run(
    "restores the choices from the browser, and forgets them on reset",
    async () => {
      const context = await (browser as Browser).newContext({
        viewport: { width: 1440, height: 900 },
      });
      const first = await open(true, 1440, context);
      await first.page.click("#rec-R1 .ch-accept span");
      await first.page.click("#rec-R2 .ch-refine span");
      await first.page.fill('#rec-R2 [data-f="note"]', "Short.");
      await first.page.selectOption("#profile-pick", "team-standard");
      await first.page.check(
        'fieldset[data-prof="team-standard"] input[value="M12"]',
      );
      await first.page.click("#d-M1");
      await first.page.check(
        'li[data-crit="M1/ci-runs-gates-on-pr"] [data-sw]',
      );
      await first.page.fill(
        'li[data-crit="M1/ci-runs-gates-on-pr"] [data-swn]',
        "Required on main.",
      );
      const key = await first.page.evaluate(() =>
        Object.keys(window.localStorage),
      );
      expect(key).toEqual([
        `jig-audit:sindresorhus/execa:${COMMIT}:${reportFingerprint(input.source.recommendations)}`,
      ]);
      await first.page.close();

      const second = await open(true, 1440, context);
      expect(await second.page.isChecked('#rec-R1 input[value="accept"]')).toBe(
        true,
      );
      expect(await second.page.inputValue('#rec-R2 [data-f="note"]')).toBe(
        "Short.",
      );
      expect(
        await second.page.isChecked(
          'fieldset[data-prof="team-standard"] input[value="M12"]',
        ),
      ).toBe(true);
      // The flagged criterion's module stays open, with the flag and its note.
      const flag = second.page.locator(
        'li[data-crit="M1/ci-runs-gates-on-pr"]',
      );
      expect(await flag.isVisible()).toBe(true);
      expect(await flag.locator("[data-sw]").isChecked()).toBe(true);
      expect(await flag.locator("[data-swn]").inputValue()).toBe(
        "Required on main.",
      );
      expect(await second.page.locator("#tray").isVisible()).toBe(true);
      // Another profile's conditional targets start as the record has them.
      await second.page.selectOption("#profile-pick", "regulated-strict");
      expect(
        await second.page.isChecked(
          'fieldset[data-prof="regulated-strict"] input[value="M12"]',
        ),
      ).toBe(false);
      await second.page.click('[data-act="reset"]');
      expect(await second.page.locator("#tray").isVisible()).toBe(false);
      expect(await flag.locator("[data-swn]").inputValue()).toBe("");
      expect(
        await second.page.evaluate(() => Object.keys(window.localStorage)),
      ).toEqual([]);
      await context.close();
    },
  );
});

describe("what the profile, the gaps and the trend add", () => {
  run(
    "shows the signals beside the profile, the uncovered gap in the map and under the recommendations, and the trend",
    async () => {
      const { page } = await open(true);
      const text = (q: string) =>
        page
          .locator(q)
          .innerText()
          .then((t) => t.replace(/\s+/g, " ").trim());
      expect(await text("#signals h3")).toBe("Worth revisiting the profile");
      await page.click(".sig-l");
      expect(await page.evaluate(() => window.location.hash)).toBe("#signals");
      // The dot of the uncovered gap is drawn inside its ring.
      const dot = await page.evaluate(() => {
        const sq = document.querySelector(".mmap .c.unc") as Element;
        // Chrome takes a pseudo-element; happy-dom's type does not name it.
        const styleOf = getComputedStyle as unknown as (
          el: Element,
          pseudo: string,
        ) => { content: string; width: string };
        const after = styleOf(sq, "::after");
        return { content: after.content, width: after.width };
      });
      expect(dot).toEqual({ content: '""', width: "6px" });
      await page.click(".unc-n a");
      expect(await page.locator("#uncovered").isVisible()).toBe(true);
      expect(await text("#uncovered li")).toStartWith("M0 glossary-exists ");
      expect(await text(".trend-s")).toBe(
        "1 module moved up since 2026-04-02.",
      );
      expect(await text(".trend tbody tr")).toBe(
        "M2 Generated artifact freshness none ↑ up to Lite Lite",
      );
      await page.context().close();
    },
  );
});

/** Where an element sits, and whether the reader can see it. */
const box = (page: Page, selector: string) =>
  page.evaluate((q) => {
    const el = document.querySelector(q) as Element;
    const r = el.getBoundingClientRect();
    return {
      shown: getComputedStyle(el).display !== "none" && r.width > 0,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      vw: document.documentElement.clientWidth,
      vh: window.innerHeight,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  }, selector);

describe("the map's popovers and the module chips", () => {
  const statement = input.modules
    .flatMap((m) => m.criteria)
    .find((c) => c.key === "M0/glossary-exists")?.statement as string;
  const POP = "#p-c-M0-glossary-exists";

  for (const width of [1440, 390])
    run(
      `explains a criterion on hover and on focus, inside the viewport, at ${width} px`,
      async () => {
        const { page } = await open(true, width);
        expect((await box(page, POP)).shown).toBe(false);
        await page.hover('a[href="#c-M0-glossary-exists"]');
        let pop = await box(page, POP);
        expect(pop.shown).toBe(true);
        expect(pop.text).toContain(statement);
        expect(pop.text).toContain("No recommendation covers it.");
        expect(pop.left).toBeGreaterThanOrEqual(0);
        expect(pop.right).toBeLessThanOrEqual(pop.vw);
        // The pointer can move onto the explanation without it closing.
        await page.mouse.move(
          (pop.left + pop.right) / 2,
          (pop.top + pop.bottom) / 2,
          { steps: 12 },
        );
        expect((await box(page, POP)).shown).toBe(true);
        await page.mouse.move(0, 0);
        expect((await box(page, POP)).shown).toBe(false);
        // The last mark of a row, the one nearest the right edge, by keyboard.
        const last = page.locator("#map-M1 a.cw").last();
        await last.focus();
        const id = (await last.getAttribute("aria-describedby")) as string;
        pop = await box(page, `#${id}`);
        expect(pop.shown).toBe(true);
        expect(pop.left).toBeGreaterThanOrEqual(0);
        expect(pop.right).toBeLessThanOrEqual(pop.vw);
        expect(pop.bottom).toBeLessThanOrEqual(pop.vh);
        // Escape hides it, as it hides the term tips.
        await page.keyboard.press("Escape");
        expect((await box(page, `#${id}`)).shown).toBe(false);
        await page.context().close();
      },
    );

  run("explains a criterion on focus with JavaScript off", async () => {
    const { page } = await open(false);
    await page.focus('a[href="#c-M0-glossary-exists"]');
    const pop = await box(page, POP);
    expect(pop.shown).toBe(true);
    expect(pop.text).toContain(statement);
    await page.context().close();
  });

  run(
    "names every mark for a reader who cannot see its icon or colour",
    async () => {
      const { page } = await open(true);
      expect(
        await page
          .getByRole("link", {
            name: "glossary-exists: absent; needed for the target, not met yet; a gap no recommendation covers",
            exact: true,
          })
          .count(),
      ).toBe(1);
      const names = await page
        .locator(".mmap a.cw .vh")
        .evaluateAll((els) => els.map((e) => e.textContent ?? ""));
      expect(names.length).toBe(
        input.modules.flatMap((m) => m.criteria).length,
      );
      expect(
        names.filter(
          (n) =>
            !/^[a-z0-9-]+: (absent|convention|advisory|mechanical|expected absent|not scored)/.test(
              n,
            ),
        ),
      ).toEqual([]);
      // The icons themselves are decoration beside a name.
      expect(
        await page
          .locator("svg.ic")
          .evaluateAll((els) =>
            els.every((e) => e.getAttribute("aria-hidden") === "true"),
          ),
      ).toBe(true);
      await page.context().close();
    },
  );

  run("shows a module's name and purpose beside its chip", async () => {
    const { page } = await open(true);
    const chip = page.locator("#recs .grp-h a.mchip").first();
    const module = (await chip.innerText()).trim();
    const m = input.modules.find((x) => x.module === module);
    await chip.hover();
    const id = (await chip.getAttribute("aria-describedby")) as string;
    const pop = await box(page, `#${id}`);
    expect(pop.shown).toBe(true);
    expect(pop.text).toContain(m?.purpose as string);
    expect(pop.right).toBeLessThanOrEqual(pop.vw);
    await page.context().close();
  });
});

describe("since the last audit", () => {
  run("counts and marks each change with a coloured badge", async () => {
    const { page } = await open(true);
    expect(
      (await page.locator("#since .bds .bd").allInnerTexts()).map((t) =>
        t.replace(/\s+/g, " "),
      ),
    ).toEqual([
      "Fixed 1",
      "Added by Jig 40",
      "Still open within the target 4",
      "Still open beyond the target 78",
      "Unchanged and met 36",
    ]);
    const fixed = page.locator("#since .chg-t .bd-fixed");
    expect(await fixed.count()).toBe(1);
    const colours = await fixed.evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.color, s.backgroundColor];
    });
    expect(colours[0]).not.toBe(colours[1]);
    expect(colours[1]).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      await page.locator("#since .chg-t tbody tr").first().innerText(),
    ).toMatch(
      /^M1\s+gate-set-documented\s+absent\s*→\s*to\s*convention\s+Fixed$/,
    );
    await page.context().close();
  });
});

/** Wait until the guide's view is open, or closed. */
const guideOn = (page: Page, on: boolean) =>
  page.waitForFunction(
    (want) => document.documentElement.classList.contains("guide-on") === want,
    on,
  );

/** Wait until the page's own smooth scrolling has ended: the position holds for ten frames in a row, within five seconds. */
const scrollSettled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((done, fail) => {
        const until = performance.now() + 5000;
        let last = -1;
        let held = 0;
        let frames = 0;
        const frame = () => {
          frames++;
          held = window.scrollY === last ? held + 1 : 0;
          last = window.scrollY;
          if (held >= 10) done();
          else if (performance.now() > until)
            fail(
              new Error(
                `scroll did not hold for ten frames within 5s: last at ${last}, held ${held} of ${frames} frames`,
              ),
            );
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );

/**
 * Run `start`, which begins one of the page's smooth scrolls, then `then` in the
 * frame where that scroll is seen still moving (the position changed over each
 * of the last two frames), all inside the page so no test-driver round trip can
 * let the scroll end first. Fails when no scroll is seen moving within five seconds.
 */
const duringSmoothScroll = (page: Page, start: string, then: string) =>
  page.evaluate(`new Promise((done, fail) => {
    const until = performance.now() + 5000;
    let before = window.scrollY, last = before;
    ${start};
    const frame = () => {
      const y = window.scrollY;
      if (last !== before && y !== last) { ${then}; done(); return; }
      before = last; last = y;
      if (performance.now() > until) fail(new Error("no smooth scroll seen moving within 5s, at " + y));
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })`);

describe("the guide", () => {
  run("is hidden from the report and opens as its own view", async () => {
    const { page, requests } = await open(true);
    expect(await page.locator("#guide").isVisible()).toBe(false);
    // At once, not with the page's smooth scrolling (the DOM types here lack "instant").
    await page.evaluate(
      "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
    );
    const y = await page.evaluate(() => window.scrollY);
    // A click as the reader makes it: the test driver's own click would first scroll the bar into view.
    await page
      .locator('.bar nav a[href="#guide"]')
      .evaluate((a) => (a as unknown as { click(): void }).click());
    await guideOn(page, true);
    expect(await page.locator("#guide").isVisible()).toBe(true);
    expect(await page.locator("#map").isVisible()).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    // Back returns to the report, where the reader was.
    await page.goBack();
    await guideOn(page, false);
    expect(await page.locator("#guide").isVisible()).toBe(false);
    expect(await page.locator("#map").isVisible()).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    // A word of the method opens its part of the guide; Escape returns.
    await page.click('.mhead a.term[href="#guide-levels"]');
    await guideOn(page, true);
    const levels = await box(page, "#guide-levels");
    expect(levels.top).toBeGreaterThanOrEqual(0);
    expect(levels.top).toBeLessThan(levels.vh / 2);
    await page.keyboard.press("Escape");
    await guideOn(page, false);
    expect(await page.locator("#map").isVisible()).toBe(true);
    expect(requests).toEqual([]);
    await page.context().close();
  });

  run("leaves Back within the report where the reader was", async () => {
    const { page } = await open(true);
    await page.evaluate(
      "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
    );
    const y = await page.evaluate(() => window.scrollY);
    // A link to a place in the report, not to the guide: the router has no view to switch.
    await page
      .locator('a[href^="#d-"]')
      .first()
      .evaluate((a) => (a as unknown as { click(): void }).click());
    await page.waitForFunction("location.hash.startsWith('#d-')");
    // The page scrolls smoothly: wait until it has stopped at the place.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          let last = -1;
          const tick = () => {
            if (window.scrollY === last) done();
            else {
              last = window.scrollY;
              setTimeout(tick, 250);
            }
          };
          tick();
        }),
    );
    expect(await page.evaluate(() => window.scrollY)).not.toBe(y);
    await page.goBack();
    await page.waitForFunction("location.hash === ''");
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    await page.context().close();
  });

  run(
    "returns every history entry, guide or report, to its own place",
    async () => {
      const { page } = await open(true);
      const at = (y: number) =>
        page.evaluate(
          `window.scrollTo({ top: ${y}, left: 0, behavior: 'instant' })`,
        );
      const scrollY = () => page.evaluate(() => window.scrollY);
      await at(2400);
      const a = await scrollY();
      await page
        .locator('.bar nav a[href="#guide"]')
        .evaluate((l) => (l as unknown as { click(): void }).click());
      await guideOn(page, true);
      // A jump is made again once, two frames on, if a smooth scroll moved the page after it.
      await scrollSettled(page);
      await at(600);
      const g = await scrollY();
      // Escape leaves the guide for a new report entry, scrolled elsewhere.
      await page.keyboard.press("Escape");
      await guideOn(page, false);
      await scrollSettled(page);
      await at(1200);
      expect(await scrollY()).not.toBe(a);
      // Back reaches the guide where it was left, Back again the first report entry.
      await page.goBack();
      await guideOn(page, true);
      expect(await scrollY()).toBe(g);
      await page.goBack();
      await guideOn(page, false);
      expect(await scrollY()).toBe(a);
      // Forward twice comes to the report entry's own place, not the guide's way in.
      await page.goForward();
      await guideOn(page, true);
      expect(await scrollY()).toBe(g);
      await page.goForward();
      await guideOn(page, false);
      expect(await scrollY()).toBe(1200);
      await page.context().close();
    },
  );

  run("keeps a position scrolled to just before Back", async () => {
    const { page } = await open(true);
    await page
      .locator('a[href^="#d-"]')
      .first()
      .evaluate((l) => (l as unknown as { click(): void }).click());
    await page.waitForFunction("location.hash.startsWith('#d-')");
    // A jump made while the link's smooth scroll still runs ends a few pixels off: let it end first.
    await scrollSettled(page);
    // Scroll and leave at once, before any delayed save could run.
    await page.evaluate(
      "window.scrollTo({ top: 1800, left: 0, behavior: 'instant' }); history.back()",
    );
    await page.waitForFunction("location.hash === ''");
    await page.goForward();
    await page.waitForFunction("location.hash.startsWith('#d-')");
    // The hash changes before the browser finishes restoring the scroll position.
    await page.waitForFunction("window.scrollY === 1800");
    expect(await page.evaluate(() => window.scrollY)).toBe(1800);
    await page.context().close();
  });

  run(
    "returns to the top after Back from a link followed at once",
    async () => {
      const { page } = await open(true);
      // Back while the link's smooth scroll still runs: the page must not keep part of it.
      await duringSmoothScroll(
        page,
        "document.querySelector('a[href^=\"#d-\"]').click()",
        "history.back()",
      );
      await page.waitForFunction("location.hash === ''");
      await scrollSettled(page);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.context().close();
    },
  );

  run("keeps the way back Escape makes until it is made again", async () => {
    const { page } = await open(true);
    await page.evaluate(
      "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
    );
    const y = await page.evaluate(() => window.scrollY);
    await page.evaluate("location.hash = 'guide'");
    await guideOn(page, true);
    await scrollSettled(page);
    // The same keydown that leaves the guide must not drop the jump it makes: still pending (smooth scrolling off) once the event is done.
    expect(
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
        return document.documentElement.style.scrollBehavior;
      }),
    ).toBe("auto");
    await guideOn(page, false);
    await scrollSettled(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    await page.context().close();
  });

  run(
    "stays on a part of the guide followed before the way in settles",
    async () => {
      const { page } = await open(true);
      await page.evaluate(
        "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
      );
      // The guide's last part, so arriving there means scrolling down from the guide's top.
      const part = await page.evaluate(() => {
        const all = [...document.querySelectorAll('#guide [id^="guide-"]')];
        if (!all.length) throw new Error("a part of the guide is needed");
        return (all[all.length - 1] as Element).id;
      });
      // Open the guide, then follow a link inside it before the jump to its top is made again.
      await page.evaluate(
        (id) =>
          new Promise<void>((done) => {
            window.addEventListener(
              "hashchange",
              () => {
                window.addEventListener("hashchange", () => done(), {
                  once: true,
                });
                window.location.hash = id;
              },
              { once: true },
            );
            window.location.hash = "guide";
          }),
        part,
      );
      await scrollSettled(page);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      const at = await box(page, `#${part}`);
      expect(at.top).toBeLessThan(at.vh / 2);
      await page.context().close();
    },
  );

  run(
    "returns a reloaded entry, guide or report, to its own place",
    async () => {
      const { page } = await open(true);
      const scrollY = () => page.evaluate(() => window.scrollY);
      // Scroll and reload at once, before any delayed save could run.
      await page.evaluate(
        "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
      );
      await page.reload();
      await guideOn(page, false);
      expect(await scrollY()).toBe(2400);
      await page
        .locator('.bar nav a[href="#guide"]')
        .evaluate((l) => (l as unknown as { click(): void }).click());
      await guideOn(page, true);
      await scrollSettled(page);
      await page.evaluate(
        "window.scrollTo({ top: 600, left: 0, behavior: 'instant' })",
      );
      await page.reload();
      await guideOn(page, true);
      expect(await scrollY()).toBe(600);
      await page.context().close();
    },
  );

  run("restores an entry older than the positions kept in memory", async () => {
    const { page } = await open(true);
    await page.evaluate(
      "window.scrollTo({ top: 2400, left: 0, behavior: 'instant' })",
    );
    // More entries than the in-memory positions hold, each one scrolled.
    await page.evaluate(`(async () => {
      const all = [...document.querySelectorAll('a[href^="#d-"]')];
      const links = all.filter((l, i) => all.findIndex((m) => m.getAttribute('href') === l.getAttribute('href')) === i).slice(0, 2);
      if (links.length < 2) throw new Error('two distinct links needed');
      for (let i = 0; i < 30; i++) {
        const moved = new Promise((r) => addEventListener('hashchange', r, { once: true }));
        links[i % links.length].click();
        await moved;
        window.scrollTo({ top: 100 + i, left: 0, behavior: 'instant' });
      }
    })()`);
    await page.evaluate("history.go(-30)");
    await page.waitForFunction("location.hash === ''");
    expect(await page.evaluate(() => window.scrollY)).toBe(2400);
    await page.context().close();
  });

  run(
    "keeps a position left by an immediate Back past the positions kept in memory",
    async () => {
      const { page } = await open(true);
      await page.evaluate(`(async () => {
        const all = [...document.querySelectorAll('a[href^="#d-"]')];
        const links = all.filter((l, i) => all.findIndex((m) => m.getAttribute('href') === l.getAttribute('href')) === i).slice(0, 2);
        if (links.length < 2) throw new Error('two distinct links needed');
        for (let i = 0; i < 30; i++) {
          const moved = new Promise((r) => addEventListener('hashchange', r, { once: true }));
          links[i % links.length].click();
          await moved;
          window.scrollTo({ top: 100 + i, left: 0, behavior: 'instant' });
        }
        await new Promise((r) => setTimeout(r, 300));
        // Scroll and leave at once, before any delayed save could run: the position lives only in memory.
        const back = new Promise((r) => addEventListener('popstate', r, { once: true }));
        window.scrollTo({ top: 1800, left: 0, behavior: 'instant' });
        history.back();
        await back;
        // Visit more entries than the in-memory positions hold.
        for (let i = 0; i < 25; i++) {
          const moved = new Promise((r) => addEventListener('popstate', r, { once: true }));
          history.back();
          await moved;
          await new Promise((r) => requestAnimationFrame(r));
        }
      })()`);
      await page.evaluate(`(async () => {
        const moved = new Promise((r) => addEventListener('popstate', r, { once: true }));
        history.go(26);
        await moved;
        await new Promise((r) => requestAnimationFrame(r));
      })()`);
      // The hash changes before the browser finishes restoring the scroll position.
      await page.waitForFunction("window.scrollY === 1800");
      expect(await page.evaluate(() => window.scrollY)).toBe(1800);
      await page.context().close();
    },
  );

  run(
    "keeps no more positions in memory than its bound when going Back through saved entries",
    async () => {
      const ctx = await (browser as Browser).newContext({
        viewport: { width: 1440, height: 900 },
      });
      // The cache is private to the sheet's script; its order list is the only array that receives history keys, so its largest length is the cache's size.
      await ctx.addInitScript(`(() => {
        const push = Array.prototype.push, key = /^[0-9a-z]+\\.\\d+\\.[0-9a-z]{1,4}$/;
        window.__keysHeld = 0;
        Array.prototype.push = function (...a) {
          const n = push.apply(this, a);
          if (a.length === 1 && typeof a[0] === 'string' && key.test(a[0])) window.__keysHeld = Math.max(window.__keysHeld, n);
          return n;
        };
      })()`);
      const { page } = await open(true, 1440, ctx);
      await page.evaluate(`(async () => {
        const all = [...document.querySelectorAll('a[href^="#d-"]')];
        const links = all.filter((l, i) => all.findIndex((m) => m.getAttribute('href') === l.getAttribute('href')) === i).slice(0, 2);
        if (links.length < 2) throw new Error('two distinct links needed');
        for (let i = 0; i < 60; i++) {
          const moved = new Promise((r) => addEventListener('hashchange', r, { once: true }));
          links[i % links.length].click();
          await moved;
          window.scrollTo({ top: 100 + i, left: 0, behavior: 'instant' });
        }
        window.__keysHeld = 0;
        // Each link click saved the entry it left, so every position is already in its state: leaving one by Back leaves nothing that only memory holds.
        for (let i = 0; i < 40; i++) {
          const moved = new Promise((r) => addEventListener('popstate', r, { once: true }));
          history.back();
          await moved;
          await new Promise((r) => requestAnimationFrame(r));
        }
      })()`);
      expect(
        await page.evaluate(
          () => (window as unknown as { __keysHeld: number }).__keysHeld,
        ),
      ).toBeLessThanOrEqual(21);
      await ctx.close();
    },
  );

  run(
    "keeps no more positions in memory than its bound when links branch history after an immediate Back",
    async () => {
      const ctx = await (browser as Browser).newContext({
        viewport: { width: 1440, height: 900 },
      });
      await ctx.addInitScript(`(() => {
        const push = Array.prototype.push, key = /^[0-9a-z]+\\.\\d+\\.[0-9a-z]{1,4}$/;
        window.__keysHeld = 0;
        Array.prototype.push = function (...a) {
          const n = push.apply(this, a);
          if (a.length === 1 && typeof a[0] === 'string' && key.test(a[0])) window.__keysHeld = Math.max(window.__keysHeld, n);
          return n;
        };
      })()`);
      const { page } = await open(true, 1440, ctx);
      await page.evaluate(`(async () => {
        const all = [...document.querySelectorAll('a[href^="#d-"]')];
        const links = all.filter((l, i) => all.findIndex((m) => m.getAttribute('href') === l.getAttribute('href')) === i).slice(0, 3);
        if (links.length < 3) throw new Error('three distinct links needed');
        const other = () => links.find((l) => l.getAttribute('href') !== location.hash);
        const follow = async (l) => {
          const moved = new Promise((r) => addEventListener('hashchange', r, { once: true }));
          l.click();
          await moved;
        };
        for (let i = 0; i < 40; i++) {
          const l = other();
          await follow(l);
          // Scroll and go Back before the delayed save: the entry left holds its position only in memory.
          const back = new Promise((r) => addEventListener('popstate', r, { once: true }));
          window.scrollTo({ top: 200 + i, left: 0, behavior: 'instant' });
          history.back();
          await back;
          await new Promise((r) => requestAnimationFrame(r));
          // A new link discards that forward entry from history, so its position can never be saved.
          await follow(l);
        }
      })()`);
      expect(
        await page.evaluate(
          () => (window as unknown as { __keysHeld: number }).__keysHeld,
        ),
      ).toBeLessThanOrEqual(21);
      await ctx.close();
    },
  );

  run(
    "opens at a deep link, and its back link returns to the report",
    async () => {
      const ctx = await (browser as Browser).newContext({
        viewport: { width: 1440, height: 900 },
      });
      const page = await ctx.newPage();
      await page.goto(`${URL_}#guide-profiles`);
      await guideOn(page, true);
      const profiles = await box(page, "#guide-profiles");
      expect(profiles.top).toBeGreaterThanOrEqual(0);
      expect(profiles.top).toBeLessThan(profiles.vh / 2);
      expect(profiles.text).toContain("Team/Standard");
      await page.click("#guide .g-back a");
      await guideOn(page, false);
      expect(await page.locator("#summary").isVisible()).toBe(true);
      await ctx.close();
    },
  );

  run(
    "is the page's last section without JavaScript, all of it shown",
    async () => {
      const { page } = await open(false);
      const guide = await box(page, "#guide");
      expect(guide.shown).toBe(true);
      for (const part of [
        "#guide-what",
        "#guide-idea",
        "#guide-modules",
        "#guide-profiles",
        "#guide-process",
        "#guide-read",
        "#guide-words",
      ])
        expect(await page.locator(part).isVisible()).toBe(true);
      expect(await page.locator("#guide .g-back").isVisible()).toBe(false);
      expect(await page.locator(".g-pt tbody tr").count()).toBe(
        input.modules.length,
      );
      await page.context().close();
    },
  );
});

describe("narrow screen", () => {
  for (const width of [390, 720])
    run(`keeps the profile table's headings at ${width} px`, async () => {
      const { page } = await open(true, width);
      await page.goto(`${URL_}#guide-profiles`);
      await guideOn(page, true);
      // Each heading is what the reader sees at its own place, not clipped away.
      // The page scrolls smoothly; the check scrolls at once.
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
      });
      const heads = await page.locator(".g-pt thead th").evaluateAll((els) =>
        els.map((e) => {
          e.scrollIntoView({ block: "center", inline: "center" });
          const r = e.getBoundingClientRect();
          const at = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return !!at && e.contains(at);
        }),
      );
      expect(heads.length).toBeGreaterThan(1);
      expect(heads.every(Boolean)).toBe(true);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.context().close();
    });

  for (const width of [390, 720])
    run(`has no sideways scroll at ${width} px`, async () => {
      const { page } = await open(true, width);
      await page.click("#rec-R1 .ch-decline span");
      await page.selectOption("#profile-pick", "team-standard");
      await page.click("#d-M3");
      await page.check('li[data-crit="M3/consumer-view-generated"] [data-sw]');
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.context().close();
    });
});

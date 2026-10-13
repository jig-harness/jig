/**
 * Browser checks of the audit sheet: what only a rendered page can show.
 * No network request and no console error, with and without JavaScript;
 * every section and recommendation visible with JavaScript off and in print,
 * with the choices hidden; choosing, the tray's counts and the copied text,
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
import { COMMIT, recordText, reportInput } from "./report-fixtures.ts";

// The callbacks passed to `page.evaluate` run in Chrome, not in Bun. The
// repository compiles without the DOM library, so the page globals they use
// are declared here, for this file only, with happy-dom's DOM types.
declare const document: BrowserWindow["document"];
declare const window: BrowserWindow & { copied?: string };
declare const getComputedStyle: BrowserWindow["getComputedStyle"];
declare const Event: BrowserWindow["Event"];

// Solo/Lite suggested, heading to Team/Standard: R1, R2 and R4 are for now,
// R3 and R5 (each with a lighter option) wait in the "as you grow" group.
const input = reportInput({
  record: recordText(["heading_to: team-standard"]),
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
      hidden: all("section[id], .rec, .crit li, .mrow")
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
      await page.selectOption("#profile-pick", "team-standard");

      const counts = await page.locator("#tray .counts").innerText();
      expect(counts.replace(/\s+/g, " ")).toBe(
        "Accept 1 Take the lighter option 1 Refine 1 Decline 1 This is wrong 1 profile team-standard",
      );
      expect(await page.locator("#tray .miss").innerText()).toBe(
        "Not ready to copy: R5 needs when to revisit.",
      );
      expect(await page.locator('[data-act="copy"]').isDisabled()).toBe(true);

      await page.fill('#rec-R5 [data-f="when"]', "a third maintainer joins");
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
      // The preview opens on copy and shows the same text.
      expect(await page.locator("#preview").innerText()).toBe(expected);
      await page.context().close();
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
      expect(await second.page.locator("#tray").isVisible()).toBe(true);
      await second.page.click('[data-act="reset"]');
      expect(await second.page.locator("#tray").isVisible()).toBe(false);
      expect(
        await second.page.evaluate(() => Object.keys(window.localStorage)),
      ).toEqual([]);
      await context.close();
    },
  );
});

describe("narrow screen", () => {
  for (const width of [390, 720])
    run(`has no sideways scroll at ${width} px`, async () => {
      const { page } = await open(true, width);
      await page.click("#rec-R1 .ch-decline span");
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.context().close();
    });
});

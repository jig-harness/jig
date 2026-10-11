/**
 * Browser checks of the document template: what only a rendered page can
 * show. Network and console with and without JavaScript, content with
 * JavaScript off and in print, the first screen, the top bar at every width
 * from 1024 px to 1920 px, focus for every hover, the reading measure, the
 * narrow layout, and the picks with their copy text.
 *
 * It drives the installed Google Chrome through `playwright-core`, so it
 * needs no browser download. Where Chrome is missing the checks cannot run,
 * and they are skipped with a warning. Set `GROUNDWORK_REQUIRE_BROWSER=1` on
 * a machine that must run them: there a missing browser is a failing test,
 * so a suite that never ran cannot read as a pass.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  BrowserWindow,
  Element,
  HTMLCanvasElement,
  HTMLElement as HappyHTMLElement,
  Node,
} from "happy-dom";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { renderHtml } from "../scripts/decision-sheet/html.ts";
import { plainText } from "../scripts/decision-sheet/refs.ts";
import {
  type Call,
  type DecisionSource,
  parseSource,
} from "../scripts/decision-sheet/source.ts";

// The callbacks passed to `page.evaluate` run in Chrome, not in Bun. The
// repository compiles without the DOM library, so the page globals they use
// are declared here, for this file only, with happy-dom's DOM types.
declare const document: BrowserWindow["document"];
declare const window: BrowserWindow;
declare const getComputedStyle: BrowserWindow["getComputedStyle"];
declare const localStorage: BrowserWindow["localStorage"];
declare const NodeFilter: BrowserWindow["NodeFilter"];
// happy-dom does no layout, so its element type has no `offsetParent`; Chrome's has.
type HTMLElement = HappyHTMLElement & { readonly offsetParent: Element | null };
type CanvasRenderingContext2D = NonNullable<
  ReturnType<HTMLCanvasElement["getContext"]>
>;

const FIXTURES = join(import.meta.dir, "fixtures/decision-sheet");
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as DecisionSource;

const RULING = {
  recordUrl: "https://tracker.example.com/acme/issue/ENG-210#comment-9",
  ruledAt: "2026-10-04",
};

/** The pilot with reference tokens, as a source is written now. */
function pilot(): DecisionSource {
  const source = fixture("pilot.json");
  source.myRead =
    "Count the remaining mismatches first. If they are few, choose {opt:4}. If they are many, choose {opt:3}. Do not keep {opt:1} or {opt:2} as an unattended default.";
  return source;
}
function ruledPilot(): DecisionSource {
  const source = pilot();
  (source.calls[0] as Call).ruling = { option: "3", ...RULING };
  return source;
}
const sevenCalls = () => fixture("multicall.json");
const edgeCases = () => fixture("edge-cases.json");

const SHEETS: Record<string, () => DecisionSource> = {
  pilot,
  "ruled pilot": ruledPilot,
  "seven calls": sevenCalls,
  "edge cases": edgeCases,
};

const dir = mkdtempSync(join(tmpdir(), "decision-sheet-browser-"));
const files: Record<string, string> = {};
for (const [name, make] of Object.entries(SHEETS)) {
  const file = join(dir, `${name.replace(/\W+/g, "-")}.html`);
  writeFileSync(file, renderHtml(parseSource(make()), "document"));
  files[name] = pathToFileURL(file).href;
}

// ---------- the browser, or the reason there is none ----------

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

if (!browser && process.env.GROUNDWORK_REQUIRE_BROWSER === "1")
  it("a browser is available where one is required", () => {
    throw new Error(
      `these checks need Google Chrome and found none (${missing}); GROUNDWORK_REQUIRE_BROWSER=1 makes a missing browser fail instead of skip`,
    );
  });
else if (!browser)
  console.warn(
    `decision-sheet-browser: skipped, no Chrome (${missing}). Set GROUNDWORK_REQUIRE_BROWSER=1 to make this an error.`,
  );

const browserIt = browser ? it : it.skip;
const TIMEOUT = 30_000;

async function open(
  url: string,
  options: { width?: number; height?: number; js?: boolean } = {},
): Promise<{
  page: Page;
  context: BrowserContext;
  errors: string[];
  requests: string[];
}> {
  const context = await (browser as Browser).newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    javaScriptEnabled: options.js ?? true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    if (!/^(file|data|blob|about):/.test(r.url())) requests.push(r.url());
  });
  await page.goto(url);
  return { page, context, errors, requests };
}

/** Every string leaf of free text that the sheet shows (ids, urls, dates and kinds are shown in fixed forms). */
function shownText(source: DecisionSource): string[] {
  // Owners are facets, shown capitalised. The overall read is not shown once every call is ruled.
  const skip = new Set([
    "schema",
    "id",
    "url",
    "kind",
    "commit",
    "date",
    "ruledAt",
    "recordUrl",
    "recommended",
    "option",
    "owners",
  ]);
  if (source.calls.every((c) => c.ruling)) skip.add("myRead");
  const out: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (!skip.has(key) && value.length > 3) out.push(plainText(value));
    } else if (Array.isArray(value)) for (const v of value) walk(v, key);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(source, "$");
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("network and console", () => {
  for (const js of [true, false])
    for (const [name, url] of Object.entries(files))
      browserIt(
        `${name}: no request and no console error, JavaScript ${js ? "on" : "off"}`,
        async () => {
          const { page, context, errors, requests } = await open(url, { js });
          await page.waitForTimeout(150);
          expect(requests).toEqual([]);
          expect(errors).toEqual([]);
          await context.close();
        },
        TIMEOUT,
      );
});

describe("all content is visible without JavaScript and in print", () => {
  for (const [name, make] of Object.entries(SHEETS))
    for (const mode of ["no JavaScript", "print", "narrow screen"] as const)
      browserIt(
        `${name}: ${mode}`,
        async () => {
          const { page, context } = await open(files[name] as string, {
            js: mode !== "no JavaScript",
            width: mode === "narrow screen" ? 390 : 1440,
          });
          if (mode === "print") await page.emulateMedia({ media: "print" });
          const text = squash(
            await page.evaluate(() => document.body.innerText),
          );
          const leaves = shownText(parseSource(make()));
          // A check over nothing must not pass.
          expect(leaves.length).toBeGreaterThan(40);
          const missing = leaves.filter((leaf) => !text.includes(squash(leaf)));
          expect(missing).toEqual([]);
          await context.close();
        },
        TIMEOUT,
      );

  browserIt(
    "the controls that need a script stay hidden without one, and the links still work",
    async () => {
      const { page, context } = await open(files["seven calls"] as string, {
        js: false,
      });
      expect(await page.locator(".pick:visible").count()).toBe(0);
      expect(await page.locator(".bar-picks:visible").count()).toBe(0);
      expect(await page.locator(".bar-left:visible").count()).toBe(0);
      expect(await page.locator("[data-js]:visible").count()).toBe(0);
      await page.locator('.bar a[href="#call-c"]').click();
      expect(page.url().endsWith("#call-c")).toBe(true);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "print drops the bar, the tray and the picks, and keeps the tints",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.emulateMedia({ media: "print" });
      expect(await page.locator(".bar:visible").count()).toBe(0);
      expect(await page.locator(".pick:visible").count()).toBe(0);
      const adjust = await page
        .locator(".mx td")
        .first()
        .evaluate((el) =>
          getComputedStyle(el).getPropertyValue("print-color-adjust"),
        );
      expect(adjust).toBe("exact");
      await context.close();
    },
    TIMEOUT,
  );
});

describe("first screen", () => {
  for (const name of ["pilot", "ruled pilot"])
    browserIt(
      `${name} at 1440 x 900 shows the question, the owners, the status, the reversibility, the recommendation or ruling and every matrix row`,
      async () => {
        const { page, context } = await open(files[name] as string, {
          width: 1440,
          height: 900,
        });
        const inView = (selector: string) =>
          page.locator(selector).evaluateAll((els) =>
            els.map((el) => {
              const r = el.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, h: r.height };
            }),
          );
        const regions = {
          title: ".mast h1",
          status: ".meta .st",
          owners: ".meta .own",
          reversibility: ".meta .rev dd",
          question: "#question .main",
          side: "#question .side .blk",
        };
        for (const [what, selector] of Object.entries(regions)) {
          const boxes = await inView(selector);
          expect([what, boxes.length > 0]).toEqual([what, true]);
          for (const b of boxes)
            expect([what, b.top >= 0 && b.bottom <= 900]).toEqual([what, true]);
        }
        // Every matrix row is wholly on screen, and no row wraps its option name onto a second line.
        const rows = await inView(".mx tbody tr");
        expect(rows).toHaveLength(4);
        for (const r of rows) expect(r.bottom).toBeLessThanOrEqual(900);
        // The open pilot also keeps each option name on one line. A chosen option carries a tag and may wrap.
        if (name === "pilot") {
          const nameHeights = await page
            .locator(".mx tbody th .on")
            .evaluateAll((els) =>
              els.map((el) => {
                const style = getComputedStyle(el);
                return (
                  el.getBoundingClientRect().height /
                  Number.parseFloat(style.lineHeight)
                );
              }),
            );
          for (const lines of nameHeights) expect(Math.round(lines)).toBe(1);
        }
        await context.close();
      },
      TIMEOUT,
    );

  browserIt(
    "a Pick control adds no row height to the matrix",
    async () => {
      const { page, context } = await open(files.pilot as string);
      const withPicks = await page
        .locator(".mx tbody tr")
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      await context.close();
      const bare = await open(files.pilot as string, { js: false });
      const withoutPicks = await bare.page
        .locator(".mx tbody tr")
        .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
      await bare.context.close();
      expect(withPicks).toHaveLength(4);
      withPicks.forEach((h, i) => {
        expect(h).toBeLessThanOrEqual((withoutPicks[i] as number) + 0.5);
      });
    },
    TIMEOUT,
  );
});

describe("top bar", () => {
  for (const width of [1024, 1100, 1180, 1280, 1366, 1440, 1600, 1920])
    browserIt(
      `does not clip or overlap on the seven-call source at ${width} px`,
      async () => {
        const { page, context } = await open(files["seven calls"] as string, {
          width,
          height: 900,
        });
        const report = await page.evaluate(() => {
          const bar = document.querySelector(".bar") as HTMLElement;
          const inner = document.querySelector(".bar-in") as HTMLElement;
          const nav = document.querySelector(".bar nav") as HTMLElement;
          const barRect = inner.getBoundingClientRect();
          const items = [
            ...document.querySelectorAll<HTMLElement>(
              ".bar-id, .bar nav a, .bar-left, .bar-picks",
            ),
          ].filter(
            (el) =>
              el.offsetParent !== null ||
              getComputedStyle(el).position === "fixed",
          );
          const rects = items.map((el) => ({
            el,
            r: el.getBoundingClientRect(),
          }));
          const problems: string[] = [];
          for (const { el, r } of rects) {
            const name = `${el.className || el.tagName} "${el.textContent?.trim().slice(0, 14)}"`;
            if (r.left < barRect.left - 1 || r.right > barRect.right + 1)
              problems.push(
                `${name} leaves the bar (${Math.round(r.left)}..${Math.round(r.right)})`,
              );
            // The element must be the one drawn at its own centre: nothing sits on top of it.
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            if (!hit || !(el === hit || el.contains(hit)))
              problems.push(
                `${name} is covered by ${(hit as HTMLElement | null)?.className || hit?.tagName}`,
              );
          }
          for (let i = 0; i < rects.length; i++)
            for (let j = i + 1; j < rects.length; j++) {
              const a = (rects[i] as (typeof rects)[number]).r;
              const b = (rects[j] as (typeof rects)[number]).r;
              if (
                a.left < b.right - 1 &&
                b.left < a.right - 1 &&
                a.top < b.bottom - 1 &&
                b.top < a.bottom - 1
              )
                problems.push("two bar items overlap");
            }
          return {
            problems,
            overflow: nav.scrollWidth - nav.clientWidth,
            count: items.length,
            barHeight: bar.offsetHeight,
            barVar: getComputedStyle(document.documentElement).getPropertyValue(
              "--bar-h",
            ),
            labels: [...document.querySelectorAll(".bar nav a")].map((a) =>
              a.textContent?.trim(),
            ),
          };
        });
        expect(report.problems).toEqual([]);
        expect(report.overflow).toBeLessThanOrEqual(0);
        // 7 calls, the sections, the id and the picks button: nothing was dropped.
        expect(report.count).toBeGreaterThanOrEqual(14);
        expect(report.labels).toContain("Evidence");
        expect(report.labels).toContain("Terms");
        // Sticky offsets follow the bar's real height, which grows when it wraps.
        expect(
          Math.abs(Number.parseFloat(report.barVar) - report.barHeight),
        ).toBeLessThanOrEqual(1);
        await context.close();
      },
      TIMEOUT,
    );
});

describe("hover and focus", () => {
  browserIt(
    "tracing an option works on focus, and the focused control shows a focus ring",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.keyboard.press("Tab");
      const chip = page.locator(".mx tbody tr").nth(2).locator(".chip");
      await chip.focus();
      expect(await page.locator(".mx tbody tr.hl").count()).toBe(1);
      expect(await page.locator("article.opt.hl").count()).toBe(1);
      expect(await page.locator(".sq tr.hl").count()).toBe(1);
      await page.locator(".mx tbody tr").nth(0).locator(".chip").focus();
      expect(await page.locator(".mx tbody tr.hl").count()).toBe(1);
      await page.locator("h1").click();
      await page.locator("body").press("Shift+Tab");
      expect(await page.locator(".mx tr.hl, article.opt.hl").count()).toBe(0);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "the same tracing works on hover",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.locator(".mx tbody tr").nth(1).locator(".chip").hover();
      expect(await page.locator("article.opt.hl").count()).toBe(1);
      await page.mouse.move(5, 400);
      expect(await page.locator("article.opt.hl").count()).toBe(0);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "owner and call tracing work on focus on the seven-call sheet",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      await page.keyboard.press("Tab");
      await page.locator(".meta .own").first().focus();
      // The owner is highlighted wherever the same owner appears.
      expect(await page.locator(".own.hl").count()).toBeGreaterThan(1);
      await page.locator(".idx .cchip").nth(2).focus();
      expect(await page.locator(".idx tr.hl").count()).toBe(1);
      expect(await page.locator(".bar-c.hl").count()).toBe(1);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "a term shows its meaning on hover and on focus, and Escape closes it",
    async () => {
      const { page, context } = await open(files.pilot as string);
      const term = page.locator("#question .term").first();
      const tip = page.locator("#question .tip").first();
      expect(await tip.isVisible()).toBe(false);
      await page.keyboard.press("Tab");
      await term.focus();
      expect(await tip.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await tip.isVisible()).toBe(false);
      await page.mouse.move(1, 1);
      await term.hover();
      await page.mouse.move(2, 2);
      await term.hover();
      expect(await tip.isVisible()).toBe(true);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "after Escape, a term shows its meaning again when the focus reaches it",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.keyboard.press("Tab");
      const terms = page.locator("#question .term");
      await terms.nth(0).focus();
      await page.keyboard.press("Escape");
      await terms.nth(1).focus();
      expect(await page.locator("#question .tip").nth(1).isVisible()).toBe(
        true,
      );
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "every control that can be focused shows a visible focus state",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      await page.keyboard.press("Tab");
      const selectors = [
        ".bar nav a",
        ".bar-picks",
        ".chip",
        ".cchip",
        ".ref",
        ".term",
        ".own[tabindex]",
        ".pick",
        ".idx .ct a",
      ];
      for (const selector of selectors) {
        const el = page.locator(selector).first();
        expect([selector, await el.count()]).toEqual([selector, 1]);
        await el.focus();
        const ring = await el.evaluate((node) => {
          const s = getComputedStyle(node);
          return {
            style: s.outlineStyle,
            width: Number.parseFloat(s.outlineWidth),
          };
        });
        expect([selector, ring.style !== "none" && ring.width > 0]).toEqual([
          selector,
          true,
        ]);
      }
      await context.close();
    },
    TIMEOUT,
  );
});

describe("script edge cases", () => {
  browserIt(
    "a call id that is an Object.prototype name does not break the tray",
    async () => {
      const source = pilot();
      (source.calls[0] as Call).id = "toString";
      const file = join(dir, "prototype-id.html");
      writeFileSync(file, renderHtml(parseSource(source), "document"));
      const { page, context, errors } = await open(pathToFileURL(file).href);
      // Opening the tray runs the first sync(), which must not read an inherited function as a stored pick.
      await page.click(".bar-picks");
      expect(await page.locator(".tray").isVisible()).toBe(true);
      expect(errors).toEqual([]);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "hover and focus light one option at a time, and neither clears the other",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      const keys = ".chip[data-t], .cchip[data-t]";
      const [first, second] = await page.$$eval(keys, (els) => [
        ...new Set(els.map((e) => e.getAttribute("data-t"))),
      ]);
      const lit = () =>
        page.$$eval(".hl", (els) => [
          ...new Set(els.map((e) => e.getAttribute("data-t"))),
        ]);
      await page.locator(`[data-t="${first}"]`).first().focus();
      expect(await lit()).toEqual([first]);
      await page.locator(`[data-t="${second}"]`).first().hover();
      expect(await lit()).toEqual([second]);
      await page.mouse.move(0, 0);
      expect(await lit()).toEqual([first]);
      await context.close();
    },
    TIMEOUT,
  );
});

describe("reading measure", () => {
  browserIt(
    "reading text stays at 80 characters a line or fewer, at every width",
    async () => {
      for (const width of [1100, 1440, 1920])
        for (const name of ["pilot", "seven calls"]) {
          const { page, context } = await open(files[name] as string, {
            width,
          });
          const measured = await page.evaluate(() => {
            const maxLine = (el: Element) => {
              const walker = document.createTreeWalker(
                el,
                NodeFilter.SHOW_TEXT,
              );
              const lines = new Map<number, number>();
              let n: Node | null = walker.nextNode();
              while (n) {
                const text = n.textContent ?? "";
                const range = document.createRange();
                for (let i = 0; i < text.length; i++) {
                  range.setStart(n, i);
                  range.setEnd(n, i + 1);
                  const rect = range.getClientRects()[0];
                  if (rect)
                    lines.set(
                      Math.round(rect.top / 4),
                      (lines.get(Math.round(rect.top / 4)) ?? 0) + 1,
                    );
                }
                n = walker.nextNode();
              }
              return Math.max(0, ...lines.values());
            };
            const sel = [
              ".main p",
              "p.main",
              ".side p",
              ".sum",
              ".kpr p",
              ".kpr li",
              ".br > p",
              ".sq td",
              ".ip li > span:last-child",
              ".legend li > span:last-child",
            ];
            const found: Record<string, number> = {};
            const counts: Record<string, number> = {};
            for (const s of sel) {
              const els = [...document.querySelectorAll(s)];
              counts[s] = els.length;
              found[s] = Math.max(0, ...els.map(maxLine));
            }
            return { found, counts };
          });
          // The populations the measure claims to cover must exist, or a zero passes.
          for (const required of [".main p", ".side p", ".kpr li"])
            expect([
              name,
              width,
              required,
              (measured.counts[required] ?? 0) > 0,
            ]).toEqual([name, width, required, true]);
          const widest = measured.found;
          for (const [selector, cpl] of Object.entries(widest))
            expect([name, width, selector, cpl <= 80]).toEqual([
              name,
              width,
              selector,
              true,
            ]);
          await context.close();
        }
    },
    TIMEOUT * 3,
  );
});

describe("narrow screen", () => {
  for (const width of [390, 720])
    browserIt(
      `has no sideways scroll and sets the matrix as one card per option at ${width} px`,
      async () => {
        for (const name of ["pilot", "seven calls", "edge cases"]) {
          const { page, context } = await open(files[name] as string, {
            width,
            height: 800,
          });
          const report = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth - window.innerWidth,
            cell: getComputedStyle(
              document.querySelector(
                ".mx td.k-safe, .mx td.k-risk, .mx td.k-human, .mx td.k-neutral",
              ) as Element,
            ).display,
            // Every metadata value must stay inside its own grid cell, so a
            // long status cannot run into the adjacent owners field.
            metaOverflow: [...document.querySelectorAll(".meta > div")].filter(
              (cell) => {
                const box = cell.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(cell);
                const text = range.getBoundingClientRect();
                return text.right > box.right + 0.5;
              },
            ).length,
            pickHeight: Math.min(
              ...[...document.querySelectorAll(".pick")]
                .filter((e) => (e as HTMLElement).offsetParent)
                .map((e) => e.getBoundingClientRect().height),
            ),
          }));
          expect([name, report.scroll]).toEqual([name, 0]);
          expect([name, report.metaOverflow]).toEqual([name, 0]);
          expect(report.cell).toBe("block");
          // Touch targets on a pick are 44 px.
          expect(report.pickHeight).toBeGreaterThanOrEqual(43.5);
          await context.close();
        }
      },
      TIMEOUT * 2,
    );
});

describe("picks and the copy tray", () => {
  const KEY = (id: string) => `decision-sheet:${id}`;
  const preview = (page: Page) => page.locator(".tray .preview").innerText();

  browserIt(
    "a pick on a one-call sheet is kept, shown in the bar, and named in the copy text",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.locator(".mx tbody tr").nth(2).locator(".pick").click();
      expect(await page.locator('.pick[aria-pressed="true"]').count()).toBe(2);
      expect(await page.locator(".bar-picks b").innerText()).toBe("3");
      await page.reload();
      expect(await page.locator('.pick[aria-pressed="true"]').count()).toBe(2);
      await page.locator(".bar-picks").click();
      expect(await preview(page)).toBe(
        "ENG-210: Which count wins when the supplier feed and the warehouse system disagree?\nhttps://tracker.example.com/acme/issue/ENG-210\n\nMy pick:\noption 3: Lower count wins, then review",
      );
      // Picking the same option again removes the pick.
      await page.keyboard.press("Escape");
      await page.locator("#o-a-3 .pick").click();
      expect(await page.locator('.pick[aria-pressed="true"]').count()).toBe(0);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "the copy text names each pick by call id and option id, with the recommendation beside it",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      await page.locator("#o-a-1 .pick").click();
      await page.locator("#o-c-2 .pick").click();
      await page.locator(".bar-picks").click();
      const lines = (await preview(page)).split("\n");
      expect(lines.slice(0, 4)).toEqual([
        "ENG-310: D03: How the catalogue cache combines its layers and counts its expiry",
        "https://tracker.example.com/acme/issue/ENG-310",
        "",
        "My picks:",
      ]);
      const a = lines.find((l) => l.startsWith("(a) "));
      expect(a).toBe(
        "(a) option 1: A separate shop layer (recommended: option 2)",
      );
      expect(lines.find((l) => l.startsWith("(c) "))).toMatch(
        /^\(c\) option 2: .+ \(recommended: option 1\)$/,
      );
      expect(lines.find((l) => l.startsWith("(d) "))).toMatch(
        /^\(d\) no pick yet \(recommended: option 1\)$/,
      );
      expect(lines.find((l) => l.startsWith("(b) "))).toMatch(
        /^\(b\) ruled 2026-10-05: option 1: Owned conflict, blocks the purge$/,
      );
      // Right when, open inputs and next steps join the text only when asked for.
      expect(lines.some((l) => l.includes("Right when:"))).toBe(false);
      await page.locator('.tray input[data-s="why"]').check();
      await page.locator('.tray input[data-s="open"]').check();
      const long = await preview(page);
      expect(long).toContain("    Right when: ");
      expect(long).toContain("Next steps:\n- ");
      expect(long).not.toMatch(/\{(opt|call):/);
      await page.locator(".tray textarea").fill("Ask Product first.");
      expect(
        (await preview(page)).endsWith("\n\nNote: Ask Product first."),
      ).toBe(true);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "a stored pick for a ruled call, a missing call or a missing option is dropped on load, in the bar, the call index and the tray",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      await page.evaluate(
        ([key]) =>
          localStorage.setItem(
            key as string,
            JSON.stringify({
              p: { b: "2", a: "9", z: "1", c: "1" },
              why: true,
              open: false,
              note: "",
            }),
          ),
        [KEY("ENG-310")],
      );
      await page.reload();
      // Only call c, which is open and has an option 1, keeps its pick.
      expect(await page.locator(".bar-c .p:visible").count()).toBe(1);
      expect(
        await page.locator('.bar-c[href="#call-c"] .p:visible').textContent(),
      ).toContain("1");
      expect(
        await page.locator('.bar-c[href="#call-b"] .p:visible').count(),
      ).toBe(0);
      expect(await page.locator('[data-pick-long="c"] .chip').count()).toBe(1);
      expect(
        await page.locator('.idx tr[data-t="c-b"] td').last().innerText(),
      ).toBe("");
      await page.locator(".bar-picks").click();
      const text = await preview(page);
      expect(text).toContain(
        "(b) ruled 2026-10-05: option 1: Owned conflict, blocks the purge",
      );
      expect(text).not.toContain("(b) option 2");
      expect(text).not.toContain("option 9");
      expect(await page.locator(".bar-picks b").innerText()).toBe("1 of 6");
      // The stored copy is cleaned too.
      const stored = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}"),
        KEY("ENG-310"),
      );
      expect(stored.p).toEqual({ c: "1" });
      expect(stored.why).toBe(true);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "a one-call sheet regenerated after a ruling shows no stored pick at all",
    async () => {
      const ruled = await open(files["ruled pilot"] as string);
      await ruled.page.evaluate(
        (key) => localStorage.setItem(key, JSON.stringify({ p: { a: "2" } })),
        KEY("ENG-210"),
      );
      await ruled.page.reload();
      expect(await ruled.page.locator(".pick:visible").count()).toBe(0);
      expect(await ruled.page.locator(".bar-picks:visible").count()).toBe(0);
      expect(await ruled.page.locator(".mine").count()).toBe(0);
      await ruled.context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "choosing an option in the tray keeps the focus on that option, and so does removing it",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.locator(".bar-picks").click();
      const option = page.locator('.tray .o[data-opt="2"]');
      await option.focus();
      await page.keyboard.press("Enter");
      expect(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("data-opt"),
        ),
      ).toBe("2");
      expect(await page.locator('.pick[aria-pressed="true"]').count()).toBe(2);
      await page.locator(".tray .rm").focus();
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => document.activeElement?.className)).toBe(
        "o",
      );
      expect(await page.locator('.pick[aria-pressed="true"]').count()).toBe(0);
      await context.close();
    },
    TIMEOUT,
  );

  browserIt(
    "the tray closes on Escape and returns focus to the button that opened it",
    async () => {
      const { page, context } = await open(files.pilot as string);
      await page.locator(".bar-picks").click();
      expect(await page.locator(".tray").isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      expect(await page.locator(".tray").isVisible()).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.className)).toBe(
        "bar-picks",
      );
      await context.close();
    },
    TIMEOUT,
  );
});

describe("contrast of what the browser applies", () => {
  /**
   * Every visible text, with the colour the cascade ends on and the first
   * painted background behind it, measured in each interactive state. This
   * reads computed styles, so a later override, a hover, a pressed pick or the
   * tray's option buttons are all measured as drawn; a parallel list of
   * colours (TEXT_PAIRS) or the first matching declaration cannot see them.
   */
  const sweep = (page: Page) =>
    page.evaluate(() => {
      const ctx = document.createElement("canvas").getContext("2d", {
        willReadFrequently: true,
      }) as CanvasRenderingContext2D;
      const rgba = (css: string): [number, number, number, number] => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#000";
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [
          d[0] as number,
          d[1] as number,
          d[2] as number,
          (d[3] as number) / 255,
        ];
      };
      const over = (
        top: [number, number, number, number],
        under: [number, number, number],
      ): [number, number, number] =>
        [0, 1, 2].map(
          (i) =>
            (top[i] as number) * top[3] + (under[i] as number) * (1 - top[3]),
        ) as [number, number, number];
      const lum = ([r, g, b]: [number, number, number]) => {
        const f = (v: number) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const backdrop = (el: Element): [number, number, number] => {
        const layers: [number, number, number, number][] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          const bg = rgba(getComputedStyle(n).backgroundColor);
          if (bg[3] > 0) layers.push(bg);
          if (bg[3] === 1) break;
        }
        let base: [number, number, number] = [255, 255, 255];
        for (const layer of layers.reverse()) base = over(layer, base);
        return base;
      };
      const failing: string[] = [];
      for (const el of document.body.querySelectorAll("*")) {
        const own = [...el.childNodes].some(
          (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
        );
        if (!own || el.closest("script,style,template,[hidden]")) continue;
        const style = getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          el.getClientRects().length === 0
        )
          continue;
        const bg = backdrop(el);
        const fgc = rgba(style.color);
        const fg = over(fgc, bg);
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a) as [
          number,
          number,
        ];
        const ratio = (hi + 0.05) / (lo + 0.05);
        if (ratio < 4.5)
          failing.push(
            `${el.tagName.toLowerCase()}.${(el.getAttribute("class") ?? "").replace(/\s+/g, ".")} "${(el.textContent ?? "").trim().slice(0, 24)}" ${style.color} on rgb(${bg.map(Math.round).join(",")}) is ${ratio.toFixed(2)}`,
          );
      }
      return [...new Set(failing)];
    });

  browserIt(
    "meets WCAG AA at rest, with every pick pressed, with the tray open, and under hover",
    async () => {
      const { page, context } = await open(files["seven calls"] as string);
      const seen: Record<string, string[]> = { rest: await sweep(page) };
      for (const pick of await page.locator(".pick").all()) await pick.click();
      seen.pressed = await sweep(page);
      await page.click(".bar-picks");
      seen.tray = await sweep(page);
      await page.click(".bar-picks");
      for (const selector of [
        ".chip",
        ".cchip",
        ".ref",
        ".term",
        ".pick",
        ".bar-picks",
        ".own",
        ".bar-c",
      ]) {
        const el = page.locator(selector).first();
        if ((await el.count()) === 0 || !(await el.isVisible())) continue;
        await el.hover();
        seen[`hover ${selector}`] = await sweep(page);
      }
      await context.close();
      expect(seen).toEqual(
        Object.fromEntries(Object.keys(seen).map((k) => [k, []])),
      );
    },
    TIMEOUT,
  );
});

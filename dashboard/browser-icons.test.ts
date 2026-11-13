/**
 * The icon vocabulary in a real browser against the real server: the Help
 * view lists every icon with its word from the map the views draw from; each
 * family keeps its own container in greyscale and in forced colours; and on a
 * laptop and two phones every view's icons keep their words, with no
 * horizontal scroll and no target under 44 px on a phone. How the browser is
 * found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Browser, Page } from "playwright-core";
import {
  open,
  settled,
  shoot,
  shortControls,
  shows,
  until,
} from "./browser-page.ts";
import {
  browserSuite,
  LAPTOP,
  openView,
  PHONE,
  TIMEOUT,
} from "./browser-suite.ts";
import { type Container, ICON_SETS } from "./src/icons.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const SMALL_PHONE = { width: 320, height: 568 };

/** A phone: touch, no hover, no keyboard to lean on. */
async function phone(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number },
) {
  const context = await browser.newContext({
    viewport,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await page.goto(url);
  return { page, context };
}

/** Icons whose word is neither beside them nor the name of the control they are on. */
function wordlessIcons(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main svg.lucide, .banner svg.lucide")]
      .filter((icon) => {
        if (icon.getAttribute("aria-hidden") !== "true") return true;
        const control = icon.closest("button, a, [role='button'], label");
        const field = control?.matches("label")
          ? control.querySelector("input, select, textarea")
          : null;
        const named =
          field?.getAttribute("aria-label") ??
          control?.getAttribute("aria-label") ??
          control?.textContent ??
          "";
        const beside = icon.parentElement?.textContent ?? "";
        return named.trim() === "" && beside.trim() === "";
      })
      .map((icon) => icon.getAttribute("class") ?? ""),
  );
}

/** Opens a view by a tap on its tab, as a thumb does. */
async function tapView(page: Page, label: string): Promise<void> {
  const tab = page.locator(".viewTab", { hasText: label });
  await tab.tap();
  await until(
    `the ${label} tab is current`,
    async () => (await tab.getAttribute("aria-current")) === "page",
  );
}

function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

/** One sample of each family's container on the Help view. */
const SAMPLES: Array<[Container, string]> = [
  ["pill", ".iconList[data-container='pill'] .act"],
  ["chip", ".iconList[data-container='chip'] .stageChip"],
  ["dashed", ".iconList[data-container='dashed'] .srcChip"],
  ["bare", ".iconList[data-container='bare'] .bareWord"],
];

/**
 * What tells a family apart once colour is gone: its border's style and
 * width, whether its corners are round, and whether it is filled, judged by
 * the luminance of its fill against the page's, which is what greyscale keeps.
 */
function shapes(page: Page): Promise<Record<string, string>> {
  return page.evaluate((samples) => {
    const luminance = (colour: string): number | null => {
      const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
      const [r = 0, g = 0, b = 0, a = 1] = parts;
      if (a === 0) return null;
      const lin = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const page = luminance(
      getComputedStyle(document.querySelector(".panel") ?? document.body)
        .backgroundColor,
    );
    const out: Record<string, string> = {};
    for (const [family, selector] of samples) {
      const element = document.querySelector(selector);
      if (element === null) {
        out[family] = "missing";
        continue;
      }
      const style = getComputedStyle(element);
      const fill = luminance(style.backgroundColor);
      const filled =
        fill !== null &&
        page !== null &&
        (Math.max(fill, page) + 0.05) / (Math.min(fill, page) + 0.05) >= 3;
      const width = Number.parseFloat(style.borderTopWidth);
      const height = element.getBoundingClientRect().height;
      const round = Number.parseFloat(style.borderTopLeftRadius) >= height / 2;
      out[family] = [
        width > 0 ? style.borderTopStyle : "none",
        round ? "round" : "square",
        filled ? "filled" : "open",
      ].join(" ");
    }
    return out;
  }, SAMPLES);
}

describe("the icon vocabulary", () => {
  browserIt(
    "the Help view lists every icon with its word, set by set",
    async () => {
      const server = await served("loud");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=help`,
        LAPTOP,
      );
      try {
        await shows(page, ".iconList");
        const listed = await page.evaluate(() =>
          [...document.querySelectorAll(".iconSet")].map((set) => ({
            title: set.querySelector("h3")?.textContent ?? "",
            items: [...set.querySelectorAll(".iconList li")].map((li) => ({
              word: li.textContent ?? "",
              icon: li.querySelector("svg.lucide") !== null,
            })),
          })),
        );
        expect(listed).toEqual(
          ICON_SETS.map((set) => ({
            title: set.title,
            items: Object.values(set.members).map((entry) => ({
              word: entry.word,
              icon: entry.icon !== null,
            })),
          })),
        );
        expect(await wordlessIcons(page)).toEqual([]);
        await settled(page);
        await shoot(page, "icons-help");
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "each family keeps its own container in greyscale and in forced colours",
    async () => {
      const server = await served("loud");
      for (const scheme of ["light", "dark"] as const) {
        const { page, context } = await open(
          requireBrowser(),
          server.origin,
          `${server.url}&view=help`,
          LAPTOP,
          scheme,
        );
        try {
          await shows(page, ".iconList");
          const plain = await shapes(page);
          expect(plain).toEqual({
            pill: "solid round filled",
            chip: "solid square open",
            dashed: "dashed square open",
            bare: "none square open",
          });
          await page.emulateMedia({ forcedColors: "active" });
          expect(await shapes(page)).toEqual(plain);
        } finally {
          await context.close();
        }
      }
    },
    TIMEOUT,
  );

  browserIt(
    "a cause or an answer state the map does not hold is drawn as its word",
    async () => {
      const server = await served("loud");
      const { page, context, problems } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await page.route("**/state?*", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          const need = body.value.line.needs[0];
          need.cause = "brand-new-cause";
          need.decisions[0].answerState = "contested";
          need.decisions[0].answers = [
            {
              author: "someone",
              at: "2026-11-13T09:00:00Z",
              url: "https://example.com/comment",
              choice: { option: "Keep", recommended: true, form: "approve" },
            },
          ];
          await route.fulfill({ json: body });
        });
        await page.reload();
        const card = page.locator(".pNeeds .need", {
          hasText: "brand-new-cause",
        });
        await shows(page, ".pNeeds .need");
        await until(
          "the card with the new cause is drawn",
          async () => (await card.count()) === 1,
        );
        expect(await card.locator(".answers").textContent()).toBe(
          "@someone chose Keep (the recommended option).",
        );
        expect(await card.locator(".answers svg").count()).toBe(0);
        expect(problems).toEqual([]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "the views draw acts, stages, sources, groups and lanes from the map",
    async () => {
      const server = await served("loud");
      const { page, context } = await open(
        requireBrowser(),
        server.origin,
        `${server.url}&view=needs`,
        LAPTOP,
      );
      try {
        await shows(page, ".pNeeds .need");
        const card = page.locator(".pNeeds .need").first();
        expect(await card.locator(".act svg.lucide-scale").count()).toBe(1);
        expect(await card.locator(".stageChip svg.lucide").count()).toBe(1);
        expect(
          await page.locator(".pNeeds .groupHead svg.lucide").count(),
        ).toBe(3);
        await openView(page, "Queue");
        await shows(page, ".pQueue .srcChip");
        expect(
          await page.locator(".pQueue .srcChip svg.lucide").count(),
        ).toBeGreaterThan(0);
        expect(
          await page.locator(".pQueue h3 svg.lucide").count(),
        ).toBeGreaterThan(0);
        await openView(page, "Merge");
        await shows(page, ".pMerge .groupHead");
        expect(
          await page.locator(".pMerge .groupHead svg.lucide").count(),
        ).toBe(await page.locator(".pMerge .groupHead").count());
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  for (const [name, viewport, touch] of [
    ["1440", LAPTOP, false],
    ["390", PHONE, true],
    ["320", SMALL_PHONE, true],
  ] as const)
    browserIt(
      `every view's icons keep their words at ${name} wide${touch ? ", by touch" : ""}`,
      async () => {
        const server = await served("loud");
        const { page, context } = touch
          ? await phone(requireBrowser(), server.url, viewport)
          : await open(requireBrowser(), server.origin, server.url, viewport);
        try {
          await shows(page, ".need");
          for (const label of [
            "Merge",
            "Needs you",
            "Running",
            "Queue",
            "History",
            "Help",
          ]) {
            await (touch ? tapView : openView)(page, label);
            await shows(page, "main :is(h1, h2)");
            await settled(page);
            expect({ label, wordless: await wordlessIcons(page) }).toEqual({
              label,
              wordless: [],
            });
            expect({ label, overflow: await overflow(page) }).toEqual({
              label,
              overflow: 0,
            });
            if (touch)
              expect({ label, short: await shortControls(page) }).toEqual({
                label,
                short: [],
              });
          }
          // A stage's meaning opens by a tap on a phone, never by hover alone.
          if (touch) {
            await tapView(page, "Needs you");
            await page.locator(".pNeeds .chipBtn").first().tap();
            await shows(page, ".pop");
          }
          await shoot(page, `icons-${name}`);
        } finally {
          await context.close();
        }
      },
      TIMEOUT,
    );
});

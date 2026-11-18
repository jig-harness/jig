/**
 * The card with gutter and the work identity, in a real browser against the
 * real server over the `linked` scenario: every card's chevron sits in one
 * column, a tap on a card's own space opens it and a tap on its links and
 * controls does not, nor does a selection or a scroll; Enter and o open the
 * focused card; linked work shows on the face, in the popover and in the
 * opened card; the page never says "tracker"; and all of it holds at 1440,
 * 390 and 320 pixels, the phones with touch and no hover. How the browser is
 * found and when its absence fails is `browser.test.ts`'s header.
 */
import { describe, expect } from "bun:test";
import type { Browser, Locator, Page } from "playwright-core";
import {
  type Served,
  settled,
  shortControls,
  shows,
  until,
} from "./browser-page.ts";
import { browserSuite, LAPTOP, PHONE, TIMEOUT } from "./browser-suite.ts";

const { browserIt, requireBrowser, served } = await browserSuite();

const SMALL_PHONE = { width: 320, height: 568 };

/** The views that draw cards, by their address. */
const CARD_VIEWS = ["merge", "needs", "running", "queue", "history"] as const;

/** Every view a person can open, Help among them. */
const ALL_VIEWS = [...CARD_VIEWS, "help"] as const;

/** A page at a size: a phone has touch and no hover. */
async function pageAt(
  browser: Browser,
  server: Served,
  viewport: { width: number; height: number },
  view: string,
) {
  const touch = viewport.width < 900;
  const context = await browser.newContext({
    viewport,
    hasTouch: touch,
    isMobile: touch,
  });
  const page = await context.newPage();
  // The forge is not read here: a pull request's identity stands on the line alone.
  await page.route("**/pr?*", (route) => route.fulfill({ status: 503 }));
  await page.goto(`${server.url}&view=${view}`);
  await shows(page, "main [data-card], main .emptyLine, main h2");
  await settled(page);
  return { page, context };
}

/** The card whose identity names `target`. */
function cardOf(page: Page, target: string): Locator {
  return page
    .locator("main [data-card]")
    .filter({ has: page.locator(".wid:not(.lk) .tgt", { hasText: target }) })
    .first();
}

function expanded(card: Locator): Promise<string | null> {
  return card.locator(".disc").first().getAttribute("aria-expanded");
}

/**
 * A point on the card that is its own space: no link, button, field or text
 * control under it, nor within `MARGIN` pixels of it, nor the card's edge. A
 * browser moves a tap towards the nearest thing it takes for the target
 * (Chrome's touch adjustment), so a point near the edge can open the card
 * beside it, and one near a control can press the control.
 */
async function emptyPoint(card: Locator): Promise<{ x: number; y: number }> {
  const point = await card.evaluate((element) => {
    const MARGIN = 16;
    const box = element.getBoundingClientRect();
    const own =
      "a, button, input, select, textarea, label, summary, [role='button'], [role='option'], [role='combobox'], [data-no-toggle]";
    const isOwn = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit) && hit.closest(own) === null;
    };
    for (let y = box.top + MARGIN; y < box.bottom - MARGIN; y += 4)
      for (let x = box.right - MARGIN; x > box.left + 40; x -= 8)
        if (
          [
            [0, 0],
            [-MARGIN, 0],
            [MARGIN, 0],
            [0, -MARGIN],
            [0, MARGIN],
          ].every(([dx = 0, dy = 0]) => isOwn(x + dx, y + dy))
        )
          return { x, y };
    return null;
  });
  if (point === null) throw new Error("the card has no space of its own");
  return point;
}

/** Each card's and tick row's chevron, left edge, on the view. */
function chevronLefts(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main [data-card], main .tkRow")]
      .filter((card) => card.getClientRects().length > 0)
      .map(
        (card) =>
          card.querySelector(".disc")?.getBoundingClientRect().left ?? -1,
      ),
  );
}

describe("the card with gutter", () => {
  for (const [name, viewport] of [
    ["1440", LAPTOP],
    ["390", PHONE],
    ["320", SMALL_PHONE],
  ] as const)
    browserIt(
      `puts every card's chevron at one x on each view, at ${name}`,
      async () => {
        const server = await served("linked");
        for (const view of CARD_VIEWS) {
          const { page, context } = await pageAt(
            requireBrowser(),
            server,
            viewport,
            view,
          );
          try {
            const all = page.getByRole("button", { name: /^Show all/ });
            if ((await all.count()) > 0 && (await all.first().isVisible()))
              await all.first().click();
            const lefts = await chevronLefts(page);
            expect(lefts.length).toBeGreaterThan(1);
            expect(lefts).not.toContain(-1);
            expect(new Set(lefts.map((x) => Math.round(x))).size).toBe(1);
          } finally {
            await context.close();
          }
        }
      },
      TIMEOUT,
    );

  browserIt(
    "opens on a tap on its own space, and not on a tap on its link, its Copy or its icon",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        PHONE,
        "needs",
      );
      try {
        const card = cardOf(page, "PR #475");
        expect(await expanded(card)).toBe("false");
        const opened = context.waitForEvent("page");
        await card.locator(".wid:not(.lk) a.tgt").tap();
        await (await opened).close();
        await card.locator(".wid:not(.lk) > .copy").tap();
        await card.locator(".wid:not(.lk) .wtrig").tap();
        await shows(page, ".pop");
        expect(await expanded(card)).toBe("false");
        await page.keyboard.press("Escape");
        await until(
          "the popover has closed",
          async () => (await page.locator(".pop").count()) === 0,
        );
        await card.scrollIntoViewIfNeeded();
        const at = await emptyPoint(card);
        await page.touchscreen.tap(at.x, at.y);
        await until(
          "the card opened",
          async () => (await expanded(card)) === "true",
        );
        expect(await card.locator(".detail").textContent()).toContain(
          "Linked work: none found.",
        );
        // A tap inside what it opened is reading, not closing.
        await card.locator(".detail .linkedDetail").tap();
        expect(await expanded(card)).toBe("true");
        const again = await emptyPoint(card);
        await page.touchscreen.tap(again.x, again.y);
        await until(
          "the card closed",
          async () => (await expanded(card)) === "false",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "stays as it is when a person scrolls over it on a phone",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        PHONE,
        "needs",
      );
      try {
        const card = cardOf(page, "PR #475");
        await card.scrollIntoViewIfNeeded();
        const at = await emptyPoint(card);
        const cdp = await context.newCDPSession(page);
        const touch = (
          type: "touchStart" | "touchMove" | "touchEnd",
          y: number,
        ) =>
          cdp.send("Input.dispatchTouchEvent", {
            type,
            touchPoints: type === "touchEnd" ? [] : [{ x: at.x, y }],
          });
        const before = await page.evaluate(() => window.scrollY);
        await touch("touchStart", at.y);
        for (let step = 1; step <= 6; step++)
          await touch("touchMove", at.y - step * 15);
        await touch("touchEnd", at.y - 90);
        await settled(page);
        // The gesture scrolled the page: it was a scroll, not a tap.
        expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(
          before,
        );
        expect(await expanded(card)).toBe("false");
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "stays as it is when a person selects its text, and opens by Enter and o when focused",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        LAPTOP,
        "needs",
      );
      try {
        await page.getByRole("button", { name: "Investigate group" }).click();
        const card = cardOf(page, "PR #479");
        const title = await card.locator(".itemTitle").evaluate((node) => {
          node.scrollIntoView({ block: "center" });
          const text = document.createRange();
          text.selectNodeContents(node);
          const { x, y, width, height } = text.getBoundingClientRect();
          return { x, y, width, height };
        });
        await page.mouse.move(title.x + 2, title.y + title.height / 2);
        await page.mouse.down();
        await page.mouse.move(title.x + title.width - 2, title.y + 4, {
          steps: 5,
        });
        await page.mouse.up();
        expect(
          await page.evaluate(() => String(window.getSelection())),
        ).not.toBe("");
        expect(await expanded(card)).toBe("false");

        // A selection made without leaving the tap's slop still holds it shut.
        await page.mouse.click(1, 1);
        await page.mouse.move(title.x + 4, title.y + title.height / 2);
        await page.mouse.down();
        await card.locator(".itemTitle").evaluate((node) => {
          window.getSelection()?.selectAllChildren(node);
        });
        await page.mouse.up();
        expect(await expanded(card)).toBe("false");

        // A double-click selects a word and leaves the card as it was.
        await page.mouse.click(1, 1);
        await page.mouse.dblclick(title.x + 4, title.y + title.height / 2);
        expect(await expanded(card)).toBe("false");

        await page.mouse.click(1, 1);
        await card.focus();
        await page.keyboard.press("o");
        await until(
          "o opened the card",
          async () => (await expanded(card)) === "true",
        );
        await card.focus();
        await page.keyboard.press("Enter");
        await until(
          "Enter closed the card",
          async () => (await expanded(card)) === "false",
        );
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "folds the load breakdown and the accounts list from the same gutter",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        PHONE,
        "running",
      );
      try {
        const accounts = page.locator(".acctList > .ghead .disc");
        expect(await accounts.getAttribute("aria-expanded")).toBe("true");
        await page.locator(".acctList > .ghead h3").tap();
        await until(
          "the accounts folded",
          async () =>
            (await page.locator(".pLine .acct:visible").count()) === 0,
        );
        const load = page.locator(".load .ghead");
        await load.tap();
        await shows(page, ".load .gpanel");
        const lefts = await page.evaluate(() =>
          [...document.querySelectorAll(".pLine .ghead .disc")].map((disc) =>
            Math.round(disc.getBoundingClientRect().left),
          ),
        );
        expect(new Set(lefts).size).toBe(1);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the work identity and its linked work", () => {
  browserIt(
    "shows a pull request's two linked items on its face, in its popover and in the opened card",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        LAPTOP,
        "needs",
      );
      try {
        const card = cardOf(page, "PR #456");
        expect(
          await card.locator(".rowTop .links .tgt").allTextContents(),
        ).toEqual(["WEB-401", "WEB-405"]);
        await card.locator(".wid:not(.lk) .wtrig").click();
        await shows(page, ".pop");
        const pop = page.locator(".pop");
        expect(await pop.locator(".wLinkedList .m").allTextContents()).toEqual([
          "WEB-401",
          "WEB-405",
        ]);
        expect(await pop.textContent()).toContain("Pull request, not read yet");
        await page.keyboard.press("Escape");
        await card.locator(".disc").click();
        expect(
          await card.locator(".detail .linkedDetail .tgt").allTextContents(),
        ).toEqual(["WEB-401", "WEB-405"]);

        const three = cardOf(page, "PR #1210");
        expect(
          await three.locator(".rowTop .links .tgt").allTextContents(),
        ).toEqual(["API-50", "API-51"]);
        expect(await three.locator(".rowTop .linkMore").textContent()).toBe(
          "+1 more",
        );
        await three.locator(".disc").click();
        expect(
          await three.locator(".detail .linkedDetail .tgt").allTextContents(),
        ).toEqual(["API-50", "API-51", "API-52"]);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "shows an item's linked pull request the same way, with its tracker named",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        LAPTOP,
        "needs",
      );
      try {
        await page.getByRole("button", { name: "Investigate group" }).click();
        const card = cardOf(page, "API-77");
        expect(
          await card.locator(".rowTop .links .tgt").allTextContents(),
        ).toEqual(["PR #1207"]);
        await card.locator(".wid:not(.lk) .wtrig").click();
        await shows(page, ".pop");
        const pop = page.locator(".pop");
        expect(await pop.locator(".wKind").textContent()).toBe("Jira issue");
        expect(await pop.locator(".wLinkedList").textContent()).toContain(
          "PR #1207",
        );
        expect(
          await pop.getByRole("link", { name: "Open in Jira" }).count(),
        ).toBe(1);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "says none found and not known for this read apart, in the popover and the opened card",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        LAPTOP,
        "needs",
      );
      try {
        for (const [target, words] of [
          ["PR #475", "Linked work: none found."],
          ["PR #95", "Linked work: not known for this read."],
        ] as const) {
          const card = cardOf(page, target);
          expect(await card.locator(".rowTop .links").count()).toBe(0);
          await card.locator(".wid:not(.lk) .wtrig").click();
          await shows(page, ".pop");
          expect(await page.locator(".pop .wLinked").textContent()).toBe(words);
          await page.keyboard.press("Escape");
          await until(
            "the popover closed",
            async () => (await page.locator(".pop").count()) === 0,
          );
          await card.locator(".disc").click();
          expect(
            await card.locator(".detail .linkedDetail").textContent(),
          ).toBe(words);
        }
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );

  browserIt(
    "leaves no card a sentence that repeats where the identity goes",
    async () => {
      const server = await served("linked");
      for (const view of CARD_VIEWS) {
        const { page, context } = await pageAt(
          requireBrowser(),
          server,
          LAPTOP,
          view,
        );
        try {
          const closed = page.locator(
            "main .disc[aria-expanded='false']:visible",
          );
          for (let left = await closed.count(); left > 0; left--)
            await closed.first().click();
          const text = (await page.locator("main").textContent()) ?? "";
          expect(text).not.toContain("Open the pull request");
          expect(text).not.toContain("Open in the");
        } finally {
          await context.close();
        }
      }
    },
    TIMEOUT,
  );
});

/** The word with its context; a configuration key the page quotes (`issue_tracker.team`) is the setting's own name, not the word. */
const SAYS_TRACKER = /.{0,40}(?<!issue_)tracker.{0,40}/gi;

/** Every string the page shows or names a control by, on the open view. */
function renderedStrings(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    // The text a person sees: no script, style or hidden element's.
    ...[...document.querySelectorAll("body *")]
      .filter(
        (element) =>
          !element.matches("script, style, template") &&
          element.getClientRects().length > 0,
      )
      .flatMap((element) =>
        [...element.childNodes].flatMap((node) =>
          node.nodeType === Node.TEXT_NODE ? (node.textContent ?? []) : [],
        ),
      ),
    ...[...document.querySelectorAll("[aria-label], [title], [placeholder]")]
      .filter((element) => element.closest("[aria-hidden='true']") === null)
      .flatMap((element) =>
        ["aria-label", "title", "placeholder"].flatMap(
          (name) => element.getAttribute(name) ?? [],
        ),
      ),
  ]);
}

describe("a need of the whole host", () => {
  browserIt(
    "draws its account as plain text, with no work identity",
    async () => {
      const server = await served("linked");
      const { page, context } = await pageAt(
        requireBrowser(),
        server,
        LAPTOP,
        "needs",
      );
      try {
        const card = page
          .locator("main [data-card]")
          .filter({ hasText: "account a" })
          .first();
        expect(await card.locator(".tgt").first().textContent()).toBe(
          "account a",
        );
        expect(await card.locator(".wtrig").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
    TIMEOUT,
  );
});

describe("the page's words", () => {
  browserIt(
    "never say tracker on any view, its cards and folds open and an identity's popover shown",
    async () => {
      const server = await served("linked");
      for (const view of ALL_VIEWS) {
        const { page, context } = await pageAt(
          requireBrowser(),
          server,
          LAPTOP,
          view,
        );
        try {
          const closed = page.locator(
            "main .disc[aria-expanded='false']:visible",
          );
          for (let left = await closed.count(); left > 0; left--)
            await closed.first().click();
          const said = (await renderedStrings(page)).flatMap(
            (s) => s.match(SAYS_TRACKER) ?? [],
          );
          expect({ view, said }).toEqual({ view, said: [] });
          const identities = page.locator("main .wid:not(.lk) .wtrig");
          const count = await identities.count();
          for (let i = 0; i < count; i++) {
            await identities.nth(i).click();
            await shows(page, ".pop");
            const popped = (
              (await page.locator(".pop").textContent()) ?? ""
            ).match(SAYS_TRACKER);
            expect({ view, popped }).toEqual({ view, popped: null });
            await page.keyboard.press("Escape");
            await until(
              "the popover closed",
              async () => (await page.locator(".pop").count()) === 0,
            );
          }
        } finally {
          await context.close();
        }
      }
    },
    TIMEOUT * 3,
  );
});

describe("on a phone", () => {
  for (const [name, viewport] of [
    ["390", PHONE],
    ["320", SMALL_PHONE],
  ] as const)
    browserIt(
      `fits with every card open and a popover shown, every target 44 px, at ${name}`,
      async () => {
        const server = await served("linked");
        for (const view of CARD_VIEWS) {
          const { page, context } = await pageAt(
            requireBrowser(),
            server,
            viewport,
            view,
          );
          try {
            const all = page.getByRole("button", { name: /^Show all/ });
            if ((await all.count()) > 0 && (await all.first().isVisible()))
              await all.first().tap();
            const closed = page.locator(
              "main .disc[aria-expanded='false']:visible",
            );
            for (let left = await closed.count(); left > 0; left--)
              await closed.first().tap();
            await page.locator("main .wid:not(.lk) .wtrig").first().tap();
            await shows(page, ".pop");
            expect(
              await page.evaluate(
                () =>
                  document.documentElement.scrollWidth -
                  document.documentElement.clientWidth,
              ),
            ).toBeLessThanOrEqual(0);
            expect({ view, short: await shortControls(page) }).toEqual({
              view,
              short: [],
            });
          } finally {
            await context.close();
          }
        }
      },
      TIMEOUT * 2,
    );
});
